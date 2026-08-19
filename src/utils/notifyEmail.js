'use strict';
const nodemailer = require('nodemailer');
const geoip = require('geoip-lite');

const mailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
  },
});

function sendSignupNotification({ first_name, last_name, email, phone, organization_name, req }) {
  const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const geo = geoip.lookup(clientIp);
  const location = geo
    ? `${geo.city || ''}, ${geo.region || ''}, ${geo.country || ''}`.replace(/^,\s*|,\s*,/g, '')
    : 'Unknown';

  const html = `
    <h3>New stocklyte Trial Signup</h3>
    <p><b>Organization:</b> ${organization_name}</p>
    <p><b>Name:</b> ${first_name} ${last_name || ''}</p>
    <p><b>Email:</b> ${email}</p>
    <p><b>Phone:</b> ${phone || 'N/A'}</p>
    <p><b>IP Address:</b> ${clientIp || 'Unknown'}</p>
    <p><b>Location:</b> ${location}</p>
  `;

  mailTransporter.sendMail({
    from: process.env.SMTP_USER,
    to: process.env.NOTIFY_EMAIL,
    subject: `New Trial Signup: ${organization_name}`,
    html,
  }).catch(err => console.error('❌ Signup email notification failed:', err.message));
}

module.exports = { sendSignupNotification, mailTransporter };
