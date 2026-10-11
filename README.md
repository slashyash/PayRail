PayRail — Double-Entry Payments & Settlement Engine

Repository: https://github.com/slashyash/PayRail

> DBMS Course Project · Full-Stack Database Application

PayRail is the money layer of a multi-vendor marketplace. Customers pay the
platform, the platform keeps a commission and GST, owes the rest to one or more
vendors, handles refunds, pays vendors out, and reconciles everything against
the payment gateway's settlement report.

Every money movement is recorded as a double-entry journal entry whose
debits equal its credits. The database itself enforces that rule, keeps the
ledger append-only, and prevents double payouts under concurrent requests.

Team

Name	ID	Main responsibility
Member 1	ID	see contributions below
Member 2	ID	
Member 3	ID	
Member 4	ID	
	Technology stack

Layer	Choice
Database	PostgreSQL 16 (schema payrail)
Backend	Node.js 22 + Express, pg (node-postgres) with hand-written parameterised SQL
Front end	React (Vite) + Tailwind CSS
Dev setup	Docker Compose (Postgres), seed script in pure SQL
	Repository structure

db/
  01_schema.sql              12 tables, keys, CHECK/UNIQUE/NOT NULL constraints
  02_triggers.sql            balanced-entry, append-only, refund cap, KYC gate, state machine
  03_views.sql               v_order_summary, v_account_balances, v_vendor_statement
  04_functions.sql           stored functions for every money workflow
  05_indexes.sql             partial unique index + performance indexes
  06_seed.sql                90 days of simulated activity (~32,000 rows)
  07_queries.sql             the 7 non-trivial report queries (Q1–Q7)
  08_demo_integrity.sql      Workflow 3 demo: 11 corruption attempts, all rejected
  09_demo_concurrency_A.sql  Workflow 2 demo, terminal 1
  09_demo_concurrency_B.sql  Workflow 2 demo, terminal 2
  run_all.sh                 rebuilds the database from scratch (01 → 06)
docs/
  PayRail_Database_Design.pdf       mid-sem database design document (5 pages)
  PayRail_Application_Design.pdf    workflows, architecture, stack, progress
  src/                              HTML sources of both PDFs — edit these
  build_docs.sh                     rebuilds the PDFs (pip install weasyprint)
  diagrams/                         ER, relational schema and architecture sources (.dot) + PNGs
                                    make_schema_diagram.py regenerates the schema diagram from the DB
docker/initdb/00_payrail.sh         container init hook
docker-compose.yml

Setup

Option A — Docker (recommended)

docker compose up -d            # builds schema + seed on first start (~5 s)
psql postgres://postgres:postgres@localhost:5432/payrail

docker compose down -v wipes the database; the next up rebuilds it.

Option B — Local PostgreSQL 16

createdb payrail
./db/run_all.sh payrail         # runs 01_schema.sql … 06_seed.sql in order

run_all.sh drops and recreates schema payrail, so it can be re-run any time.
In psql, run SET search_path TO payrail; (or prefix names with payrail.).

Running the demos

psql -d payrail -f db/07_queries.sql          # all report queries
psql -d payrail -f db/08_demo_integrity.sql   # every attack must print an ERROR

Concurrency (two terminals):

# terminal 1 — pauses while holding the lock
psql -d payrail -f db/09_demo_concurrency_A.sql
# terminal 2 — blocks, then fails with "Insufficient balance"
psql -d payrail -f db/09_demo_concurrency_B.sql

Major workflows

Checkout & payment capture. fn_place_order creates the order with
   price/commission snapshots. fn_capture_payment (gateway webhook) is
   idempotent, locks the order, and posts one balanced journal entry:
   Dr gateway clearing; Cr each vendor's payable, platform commission, GST.
Vendor payout under concurrency. fn_request_payout locks the vendor's
   account row (SELECT … FOR UPDATE), checks the derived balance, creates the
   payout and posts Dr vendor payable / Cr bank. fn_complete_payout marks it
   paid, or reverses the entry if the bank transfer fails.
Refunds & integrity enforcement. fn_request_refund → trigger checks the
   refund cap; fn_approve_refund posts the mirror-image entry. The integrity demo
   shows the DBMS rejecting unbalanced entries, edits to history, over-refunds,
   payouts to non-KYC vendors, duplicate captures and invalid values.
Reconciliation & reports. fn_record_settlement posts matched settlement
   lines; Q3 classifies every payment as MATCHED / IN_TRANSIT / MISSING /
   AMOUNT_MISMATCH / UNKNOWN. Q1 trial balance, Q2 vendor statement, Q4–Q7
   analytics.

Progress (mid-sem)

Requirements, ER/EER design, relational schema, normalization
Complete database layer: tables, constraints, triggers, functions, views, indexes
Seed data (~32,000 rows) generated through the same functions the app uses
Report queries Q1–Q7 and integrity/concurrency demo scripts
Express API (routes, auth, validation)
React front end (storefront, vendor dashboard, finance console)
Mock gateway simulator (webhooks + settlement CSV upload)

Contributions

Fill in per member: design, SQL objects, backend routes, front-end screens, docs.
