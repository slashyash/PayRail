# PayRail — Double-Entry Payments & Settlement Engine

DBMS Course Project · Mid-Semester Submission · **Group 13**

PayRail is a proposed payments and settlement application for a multi-vendor marketplace. It will track customer payments, platform commission, GST on commission, vendor balances, refunds, payouts and payment-gateway settlements.

The database design uses a double-entry ledger: every journal entry has equal total debits and credits. Balances are derived from ledger entries, and corrections are represented by reversing entries. Transactions, constraints and row locks are planned to maintain consistency and prevent concurrent payouts from exceeding the available balance.

## Team

**Team name: PayRail**

| Member | Student ID |
|---|---|
| Aluri Venkata Sai Anirudh | 2023B2AD0824H |
| Yash Jain | 2023B2A80958H |
| Aryan Saini | 2024A2PS1154H |
| Parth Gupta | 2023B4AD0741H |
| Harsha Vardhan | 2023B4AD1155H |

## Current progress

The project is currently at the **database and application design stage**. Implementation has not started.

Completed design work:

- Defined the problem, intended users, scope, assumptions and business rules.
- Prepared the ER/EER model and a relational schema with 12 relations.
- Specified primary and foreign keys, uniqueness, nullability and integrity constraints.
- Documented normalization and key schema-design decisions.
- Designed the application architecture, technology stack and major workflows.
- Planned database functions, triggers, views, reports and concurrency demonstrations.

Next steps:

- Implement the PostgreSQL schema and database objects.
- Populate sample data and test constraints, reports and concurrent transactions.
- Build the Express API and React interface.
- Integrate the mock payment gateway and settlement-upload workflow.
- Test the complete application and prepare the final demonstration.

## Design documents

The mid-semester submission comprises:

- **PayRail_Database_Design.pdf** — ER/EER diagram, relational schema, keys, integrity constraints, assumptions and normalization/design justification.
- **PayRail_Application_Design.pdf** — proposed workflows, architecture, technology stack and team responsibilities.

Include the latest versions of both PDFs in the repository with this README.

## Proposed technology stack

| Layer | Technology |
|---|---|
| Database | PostgreSQL 16 |
| Backend | Node.js 22, Express and `pg` with parameterised SQL |
| Front end | React with Vite and Tailwind CSS |
| Development environment | Docker Compose for PostgreSQL; SQL scripts for schema creation and sample data |

Architecture: **React interface ↔ Express API ↔ PostgreSQL database**. A mock gateway will simulate payment callbacks and settlement reports.

## Major application workflows

1. **Checkout and payment capture:** create an order, snapshot product prices and commission rates, and record payment attempts. A successful capture will create a balanced journal entry allocating the payment to vendor payables, platform commission and GST. Idempotency keys will prevent repeated callbacks from creating duplicate records.
2. **Vendor payouts:** lock the vendor's account, check the derived balance and record the payout within a transaction. Concurrent requests for the same vendor will be processed in sequence. A failed transfer will produce a reversing entry.
3. **Refunds and integrity checks:** request refunds against individual order lines, validate eligibility and refundable limits, and post the approved refund entries. Planned tests will cover unbalanced entries, changes to ledger history, excessive refunds and duplicate captures.
4. **Settlement reconciliation and reporting:** compare payment records with gateway settlement reports, identify missing or mismatched settlements, and produce trial balances, vendor statements, performance reports and aging reports.

## Important order-item rule

A product may appear **only once in an order**. Adding the same product again increases the quantity on its existing line, subject to the combined quantity limit of 1–100.

The proposed `order_items` relation retains the primary key `(order_id, line_no)` and adds `UNIQUE(order_id, product_id)`, with both columns mandatory. The order/product pair is therefore an additional candidate key, as reflected in the normalization justification. Each line stores its purchase-time price and commission rate.

## Team contributions and responsibilities

The following table records the team's allocation of design work and planned implementation ownership. Each member has an equal share of the design responsibilities.

| Member | Design responsibility | Planned implementation ownership |
|---|---|---|
| Aluri Venkata Sai Anirudh | Requirements, business rules and ER/EER modelling | Design documentation and schema consistency |
| Yash Jain | Relational schema, keys and normalization analysis | Schema integration and integrity validation |
| Aryan Saini | Ledger constraints, trigger design and integrity-test scenarios | Refund/payout validation and concurrency testing |
| Parth Gupta | Workflow-function design and transaction/concurrency planning | Backend API, authentication and mock-gateway integration |
| Harsha Vardhan | Sample-data planning, reporting queries, views and index design | Frontend dashboards and report integration |

## Setup and execution

There is no runnable application at this stage. Database scripts, sample data and setup/run instructions will be added as implementation progresses. The current submission is for review of the proposed design.
