# Query patterns

Known-good SuiteQL and saved search IDs. Add one every time you validate a
query by hand.

## SuiteQL dialect reminders

SuiteQL is SQL-92 plus Oracle functions. Common mistakes:

| Instead of | Use |
| --- | --- |
| `LIMIT 10` / `TOP 10` | `WHERE ROWNUM <= 10` |
| `ISNULL()` / `IFNULL()` | `NVL()` |
| `SUBSTRING()` / `LEFT()` | `SUBSTR()` |
| `NOW()` / `GETDATE()` | `CURRENT_DATE` or `SYSDATE` |
| `CONCAT(a, b)` or `a + b` | `a || b` |
| `'2024-01-01'` | `TO_DATE('2024-01-01', 'YYYY-MM-DD')` |
| `WITH cte AS (...)` | Not supported. Use inline subqueries. |
| `OFFSET n ROWS FETCH NEXT` | Not supported. Use ROWNUM-based paging. |

Mixing ANSI JOINs with comma-style joins in one statement is rejected. The
legacy Oracle `(+)` outer join operator is rejected. IN lists cap around 1000
expressions.

## Validated queries

<!--
Add each one you have checked against a known answer:

### Subsidiaries
SELECT id, name FROM subsidiary

-->

## Validated saved searches

<!-- ID, what it returns, and when to use it instead of writing SuiteQL. -->
