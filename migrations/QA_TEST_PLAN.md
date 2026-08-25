# StockLyte QA Test Plan — credentials, data, and action sequence

Run `003_qa_test_data.sql` first (after `001` and `002`, already applied). Everything below assumes that data is in place.

## 1. Credentials (all passwords: `Test@12345`)

| App | Email | Role | Location |
|---|---|---|---|
| Super Admin | `qa.superadmin@stocklyte-test.local` | super_admin | — |
| Tenant | `qa.productrequests.test@stocklyte-test.local` | admin | none (acts for any location) |
| Tenant | `d1.staff@stocklyte-test.local` | staff | D1 — New York |
| Tenant | `d1.viewer@stocklyte-test.local` | viewer | D1 — New York |
| Tenant | `d2.staff@stocklyte-test.local` | staff | D2 — Philadelphia |
| Tenant | `d2.manager@stocklyte-test.local` | manager | D2 — Philadelphia |
| Tenant | `d3.staff@stocklyte-test.local` | staff | D3 — Chicago |

Tenant: **QA Test - Product Requests** (schema `qa_test_product_requests`).

## 2. Master data now in place

- **Locations**: D1 New York, D2 Philadelphia, D3 Chicago, D4 Boston (new) — D1/D2/D4 in "Northeast Cluster", D3 in "Midwest Cluster".
- **Racks**: A1, A2 under D1; B1 under D2.
- **Routing rules** (deterministic escalation order for D1): D2 (priority 1) → D3 (priority 2) → D4 (priority 3).
- **Products**: `QA-WIDGET-001` (stock: 22@D1, 45@D2, 35@D3, 15@D4), `QA-WIDGET-002` "Scarce" (stock: 1@D1, **0 everywhere else** — deliberately, to force a rejection), `QA-GADGET-003` (stock: 50@D1, for damaged-stock testing).

## 3. Planned action sequence (I will run this via the API once you confirm the SQL is applied — or you can run it yourself via the app UI and send me the results either way)

### A. Super Admin
1. Login as `qa.superadmin@stocklyte-test.local`. **Expect**: 200, `role: super_admin`.
2. `GET /admin/companies` — expect the QA tenant listed with `admin_count: 6`.
3. `GET /admin/dashboard/stats` — expect totals including this tenant.
4. `POST /admin/companies/qa_test_product_requests/extend-trial {days: 10}` — expect `trial_ends_at` pushed out 10 days.
5. `POST /admin/companies/qa_test_product_requests/suspend` then `/reactivate` — expect `subscription_status` to flip `cancelled` → `active`.
6. Attempt a tenant-only route (e.g. `GET /locations`) with the super admin's token — **expect a clean 4xx error, not data** (confirms a super admin can't accidentally read tenant data).

### B. Tenant — baseline reads (as `qa.productrequests.test@...`, admin)
7. `GET /auth/me`, `GET /locations`, `GET /clusters`, `GET /racks`, `GET /categories`, `GET /products`, `GET /stock`, `GET /team`, `GET /routing-rules?source_location_id=D1`. Expect every one populated with the rows from §2 — not empty, not mock data.

### C. Cluster-based Product Request & Rejection workflow (the core feature)
8. As `d1.staff@...`: `POST /product-requests { product_id: QA-WIDGET-001, quantity: 10, note: "QA escalation test" }`.
   **Expect**: `status: assigned`, `current_target_location_id: D2` (per the routing rule), a route row (seq 1, target D2, pending), 2 history rows (requested→assigned).
9. As `d2.staff@...`: `POST /product-requests/{id}/reject { note: "D2 declining for QA test" }`.
   **Expect**: escalates — `status: assigned`, `current_target_location_id: D3`, a 2nd route row (seq 2, target D3), history rows recording rejected→escalated→assigned. D2's `reserved_quantity` for this product released back to 0.
10. As `d3.staff@...`: `POST /product-requests/{id}/accept`.
    **Expect**: `status: accepted`. D3's stock **quantity** for QA-WIDGET-001 drops by 10 (35→25). D1's stock **in_transit_quantity** rises by 10 (0→10). A `stock_transactions` row (`transaction_type: transfer`, `related_request_id` = this request).
11. As `d1.staff@...`: `POST /product-requests/{id}/receive`.
    **Expect**: `status: fulfilled`, `resolved_at` set. D1's **quantity** rises by 10, **in_transit_quantity** back to 0.
12. `GET /product-requests/{id}` — **expect** the full `routes` (2 hops: D2 rejected, D3 accepted) and `history` (requested→assigned→rejected→escalated→assigned→accepted→fulfilled) — this is the "complete request history and status transitions" requirement.
13. Second request, forced to exhaustion: as `d1.staff@...`, `POST /product-requests { product_id: QA-WIDGET-002 (Scarce), quantity: 5 }` → assigned to D2. Reject at D2, reject at D3 (both have 0 stock of it), reject at D4. **Expect**: after the 3rd rejection, `status: exhausted` (no more eligible targets), and D1 gets notified.
14. Third request, cancellation: as `d1.staff@...`, create another small request, then `POST /product-requests/{id}/cancel {reason: "QA test cancel"}` while still `assigned`. **Expect**: `status: cancelled`, reserved stock released.
15. Notifications: as `d2.staff@...`, `GET /notifications` after step 8 — **expect** a `product_request` notification with an actionable Accept/Reject affordance tied to that request.

### D. Damaged stock
16. As `d1.staff@...`: `POST /stock/damage {product_id: QA-GADGET-003, location_id: D1, quantity: 8}`. **Expect**: `quantity` 50→42, `damaged_quantity` 0→8.
17. `POST /stock/damage/restore` for 3 of those 8. **Expect**: `quantity` 42→45, `damaged_quantity` 8→5.
18. As `qa.productrequests.test@...` (admin): `POST /stock/damage/writeoff` for the remaining 5. **Expect**: `damaged_quantity` 5→0, permanently (not returned to available).
19. As `d1.viewer@...`, attempt any of steps 16-18. **Expect**: 403 (viewer can't write).

### E. Tenant isolation
20. Confirm none of the above ever required or accepted a `tenant_schema`/company identifier from the client — it's always taken from the JWT. As a structural check, decode the token issued in step 8 and confirm `tenant_schema: "qa_test_product_requests"` is embedded and can't be swapped by the client.

## 4. What to send back to me

Either paste the JSON responses from the calls above as you make them, or just tell me "go ahead" and I'll run this exact sequence myself via the API against the now-seeded data and report the real results — whichever you'd prefer.
