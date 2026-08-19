'use strict';
const cron = require('node-cron');
const { pool, withTenant } = require('./db');
const { mailTransporter } = require('./notifyEmail');

// Trial data lives on public.companies (schema_name, subscription_status,
// trial_ends_at) — the tenant's own admin_users table has no subscription columns —
// so each company is looked up here, then its Company Admin(s) are fetched from that
// company's own schema via withTenant.
async function findAdmins(schemaName) {
  return withTenant(schemaName, async (client) => {
    const { rows } = await client.query(
      `select email, full_name from admin_users where role = 'admin' and is_active`
    );
    return rows;
  });
}

async function sendReminder(company, admins, daysLeft) {
  const expiryDate = new Date(company.trial_ends_at).toDateString();
  const plural = daysLeft > 1 ? 's' : '';

  for (const admin of admins) {
    const displayName = admin.full_name || admin.email;
    const html = `
      <h3>Your Vaultiq Trial is Expiring Soon</h3>
      <p>Hi <b>${displayName}</b>,</p>
      <p>The free trial for <b>${company.name}</b> will expire in <b>${daysLeft} day${plural}</b> on <b>${expiryDate}</b>.</p>
      <p>To keep your admin and staff accounts working without interruption, contact us at <a href="mailto:info@impacgo.com">info@impacgo.com</a> to upgrade before then.</p>
      <br/><p>— The Vaultiq Team</p>
    `;
    await mailTransporter.sendMail({
      from: process.env.SMTP_USER,
      to: admin.email,
      subject: `Your Vaultiq trial expires in ${daysLeft} day${plural}`,
      html,
    }).catch((err) => console.error(`Failed to notify tenant admin ${admin.email}:`, err.message));
  }

  const internalHtml = `
    <h3>Trial Expiry Alert — ${daysLeft} Day${plural} Remaining</h3>
    <p><b>Company:</b> ${company.name}</p>
    <p><b>Tenant Schema:</b> ${company.schema_name}</p>
    <p><b>Admin Email(s):</b> ${admins.map((a) => a.email).join(', ') || 'N/A'}</p>
    <p><b>Trial Expiry:</b> ${expiryDate}</p>
  `;
  await mailTransporter.sendMail({
    from: process.env.SMTP_USER,
    to: process.env.NOTIFY_EMAIL,
    subject: `Trial Expiry Alert: ${company.name} — ${daysLeft} day${plural} left`,
    html: internalHtml,
  }).catch((err) => console.error('Failed to send internal expiry-reminder alert:', err.message));
}

async function sendExpiredNotice(company, admins) {
  const expiryDate = new Date(company.trial_ends_at).toDateString();

  for (const admin of admins) {
    const displayName = admin.full_name || admin.email;
    const html = `
      <h3>Your Vaultiq Trial Has Ended</h3>
      <p>Hi <b>${displayName}</b>,</p>
      <p>The 15-day free trial for <b>${company.name}</b> ended on <b>${expiryDate}</b>. Access for your admin and staff accounts has been paused.</p>
      <p>Contact us at <a href="mailto:info@impacgo.com">info@impacgo.com</a> to resume services.</p>
      <br/><p>— The Vaultiq Team</p>
    `;
    await mailTransporter.sendMail({
      from: process.env.SMTP_USER,
      to: admin.email,
      subject: 'Your Vaultiq trial has ended',
      html,
    }).catch((err) => console.error(`Failed to notify tenant admin ${admin.email}:`, err.message));
  }

  const internalHtml = `
    <h3>Trial Expired</h3>
    <p><b>Company:</b> ${company.name}</p>
    <p><b>Tenant Schema:</b> ${company.schema_name}</p>
    <p><b>Admin Email(s):</b> ${admins.map((a) => a.email).join(', ') || 'N/A'}</p>
    <p><b>Trial Expiry:</b> ${expiryDate}</p>
  `;
  await mailTransporter.sendMail({
    from: process.env.SMTP_USER,
    to: process.env.NOTIFY_EMAIL,
    subject: `Trial Expired: ${company.name}`,
    html: internalHtml,
  }).catch((err) => console.error('Failed to send internal expiry alert:', err.message));
}

async function checkTrialExpiry() {
  console.log('Running trial expiry notification check...');
  try {
    // Reminders: still trialing, exactly 3 or 1 calendar day(s) from expiry. Date-based
    // (not timestamp-based) so this fires exactly once per company per reminder day
    // regardless of what time the cron happens to run.
    const { rows: reminders } = await pool.query(`
      select id, name, schema_name, trial_ends_at,
             (trial_ends_at::date - current_date) as days_left
      from public.companies
      where subscription_status = 'trialing'
        and trial_ends_at is not null
        and (trial_ends_at::date - current_date) in (3, 1)
    `);

    for (const company of reminders) {
      const admins = await findAdmins(company.schema_name).catch((err) => {
        console.error(`Failed to load admins for ${company.schema_name}:`, err.message);
        return [];
      });
      if (admins.length === 0) continue;
      await sendReminder(company, admins, Number(company.days_left));
      console.log(`Reminder sent for ${company.schema_name} (${company.days_left} days left)`);
    }

    // Expired: trial has actually lapsed (timestamp, not date, so this catches it as
    // soon as the cron next runs after the exact expiry moment) and hasn't been
    // notified yet — trial_expiry_notified_at guards against re-sending on every run
    // while status sits at 'expired'.
    const { rows: expired } = await pool.query(`
      select id, name, schema_name, trial_ends_at
      from public.companies
      where subscription_status in ('trialing', 'expired')
        and trial_ends_at is not null
        and trial_ends_at < now()
        and trial_expiry_notified_at is null
    `);

    for (const company of expired) {
      const admins = await findAdmins(company.schema_name).catch((err) => {
        console.error(`Failed to load admins for ${company.schema_name}:`, err.message);
        return [];
      });
      await sendExpiredNotice(company, admins);
      await pool.query(
        `update public.companies
         set subscription_status = 'expired', trial_expiry_notified_at = now()
         where id = $1`,
        [company.id]
      );
      console.log(`Expiry notice sent for ${company.schema_name}`);
    }

    if (reminders.length === 0 && expired.length === 0) {
      console.log('No trial expiry notifications needed today.');
    } else {
      console.log(`Trial expiry check done. Reminded ${reminders.length}, notified ${expired.length} expired.`);
    }
  } catch (err) {
    console.error('Trial expiry cron failed:', err.message);
  }
}

function startTrialExpiryCron() {
  cron.schedule('0 8 * * *', checkTrialExpiry);
  console.log('Trial expiry notification cron scheduled (daily at 8 AM).');
}

module.exports = { startTrialExpiryCron, checkTrialExpiry };
