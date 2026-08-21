import { toCents, type Transaction } from "@/lib/types";

/**
 * ~6 months of deterministic transactions (Mar-Aug 2026). Internal
 * consistency matters more than count — no fixed target.
 *
 * Recurring monthly pattern: salary + rent (checking), interest (savings),
 * a transfer-to-savings pair, and a credit-card-payment pair. Both movement
 * kinds carry no categoryId and are excluded from income/spending by kind,
 * not by sign alone.
 *
 * Deliberate edge cases: negative/zero/large balances (see accounts.ts),
 * a refund reducing category spend (May, and Aug where it nets against a
 * same-month purchase to a negative "spend"), a zero-amount uncategorized
 * transaction (Aug), same-day transactions (Aug 1, and each transfer pair),
 * and the Jul 31 / Aug 1 month-boundary pair.
 */
export const mockTransactions: readonly Transaction[] = Object.freeze([
  // ---- March 2026 ----
  { id: "txn-001", accountId: "acc-checking", date: "2026-03-01", merchant: "Employer Inc.", kind: "income", categoryId: "cat-salary", amountCents: toCents(320000) },
  { id: "txn-002", accountId: "acc-checking", date: "2026-03-01", merchant: "Rent Payment", kind: "expense", categoryId: "cat-housing", amountCents: toCents(-215000) },
  { id: "txn-003", accountId: "acc-checking", date: "2026-03-03", merchant: "Whole Foods Market", kind: "expense", categoryId: "cat-groceries", amountCents: toCents(-9820) },
  { id: "txn-004", accountId: "acc-checking", date: "2026-03-05", merchant: "Shell Gas Station", kind: "expense", categoryId: "cat-transportation", amountCents: toCents(-4210) },
  { id: "txn-005", accountId: "acc-credit", date: "2026-03-07", merchant: "Netflix", kind: "expense", categoryId: "cat-subscriptions", amountCents: toCents(-1599) },
  { id: "txn-006", accountId: "acc-checking", date: "2026-03-08", merchant: "Trader Joe's", kind: "expense", categoryId: "cat-groceries", amountCents: toCents(-6340) },
  { id: "txn-007", accountId: "acc-checking", date: "2026-03-10", merchant: "Electric & Water Co", kind: "expense", categoryId: "cat-utilities", amountCents: toCents(-14320) },
  { id: "txn-008", accountId: "acc-credit", date: "2026-03-12", merchant: "The Local Bistro", kind: "expense", categoryId: "cat-dining", amountCents: toCents(-5680) },
  { id: "txn-009", accountId: "acc-credit", date: "2026-03-14", merchant: "Movie Theater", kind: "expense", categoryId: "cat-entertainment", amountCents: toCents(-3200) },
  { id: "txn-010", accountId: "acc-savings", date: "2026-03-15", merchant: "Horizon Bank", kind: "income", categoryId: "cat-interest", amountCents: toCents(920) },
  { id: "txn-011", accountId: "acc-checking", date: "2026-03-16", merchant: "Transfer to Savings", kind: "transfer", movementId: "mov-transfer-2026-03", amountCents: toCents(-50000) },
  { id: "txn-012", accountId: "acc-savings", date: "2026-03-16", merchant: "Transfer from Checking", kind: "transfer", movementId: "mov-transfer-2026-03", amountCents: toCents(50000) },
  { id: "txn-013", accountId: "acc-checking", date: "2026-03-18", merchant: "Credit Card Payment", kind: "credit_card_payment", movementId: "mov-ccpay-2026-03", amountCents: toCents(-32000) },
  { id: "txn-014", accountId: "acc-credit", date: "2026-03-18", merchant: "Payment Received", kind: "credit_card_payment", movementId: "mov-ccpay-2026-03", amountCents: toCents(32000) },
  { id: "txn-015", accountId: "acc-checking", date: "2026-03-20", merchant: "Target", kind: "expense", categoryId: "cat-shopping", amountCents: toCents(-8750) },
  { id: "txn-016", accountId: "acc-credit", date: "2026-03-24", merchant: "Uber", kind: "expense", categoryId: "cat-transportation", amountCents: toCents(-1840) },
  { id: "txn-017", accountId: "acc-checking", date: "2026-03-27", merchant: "Coffee Shop", kind: "expense", categoryId: "cat-dining", amountCents: toCents(-1450) },

  // ---- April 2026 ----
  { id: "txn-018", accountId: "acc-checking", date: "2026-04-01", merchant: "Employer Inc.", kind: "income", categoryId: "cat-salary", amountCents: toCents(320000) },
  { id: "txn-019", accountId: "acc-checking", date: "2026-04-01", merchant: "Rent Payment", kind: "expense", categoryId: "cat-housing", amountCents: toCents(-215000) },
  { id: "txn-020", accountId: "acc-checking", date: "2026-04-02", merchant: "Whole Foods Market", kind: "expense", categoryId: "cat-groceries", amountCents: toCents(-10450) },
  { id: "txn-021", accountId: "acc-checking", date: "2026-04-04", merchant: "Chevron", kind: "expense", categoryId: "cat-transportation", amountCents: toCents(-3980) },
  { id: "txn-022", accountId: "acc-credit", date: "2026-04-06", merchant: "Netflix", kind: "expense", categoryId: "cat-subscriptions", amountCents: toCents(-1599) },
  { id: "txn-023", accountId: "acc-checking", date: "2026-04-09", merchant: "Trader Joe's", kind: "expense", categoryId: "cat-groceries", amountCents: toCents(-7120) },
  { id: "txn-024", accountId: "acc-checking", date: "2026-04-11", merchant: "Electric & Water Co", kind: "expense", categoryId: "cat-utilities", amountCents: toCents(-13890) },
  { id: "txn-025", accountId: "acc-credit", date: "2026-04-13", merchant: "Sushi Place", kind: "expense", categoryId: "cat-dining", amountCents: toCents(-6420) },
  { id: "txn-026", accountId: "acc-savings", date: "2026-04-15", merchant: "Horizon Bank", kind: "income", categoryId: "cat-interest", amountCents: toCents(935) },
  { id: "txn-027", accountId: "acc-checking", date: "2026-04-16", merchant: "Transfer to Savings", kind: "transfer", movementId: "mov-transfer-2026-04", amountCents: toCents(-50000) },
  { id: "txn-028", accountId: "acc-savings", date: "2026-04-16", merchant: "Transfer from Checking", kind: "transfer", movementId: "mov-transfer-2026-04", amountCents: toCents(50000) },
  { id: "txn-029", accountId: "acc-checking", date: "2026-04-18", merchant: "Credit Card Payment", kind: "credit_card_payment", movementId: "mov-ccpay-2026-04", amountCents: toCents(-41500) },
  { id: "txn-030", accountId: "acc-credit", date: "2026-04-18", merchant: "Payment Received", kind: "credit_card_payment", movementId: "mov-ccpay-2026-04", amountCents: toCents(41500) },
  { id: "txn-031", accountId: "acc-credit", date: "2026-04-19", merchant: "Concert Tickets", kind: "expense", categoryId: "cat-entertainment", amountCents: toCents(-9600) },
  { id: "txn-032", accountId: "acc-checking", date: "2026-04-22", merchant: "Urgent Care Clinic", kind: "expense", categoryId: "cat-healthcare", amountCents: toCents(-18500) },
  { id: "txn-033", accountId: "acc-credit", date: "2026-04-25", merchant: "Amazon", kind: "expense", categoryId: "cat-shopping", amountCents: toCents(-5230) },
  { id: "txn-034", accountId: "acc-checking", date: "2026-04-28", merchant: "Lyft", kind: "expense", categoryId: "cat-transportation", amountCents: toCents(-2150) },

  // ---- May 2026 ----
  { id: "txn-035", accountId: "acc-checking", date: "2026-05-01", merchant: "Employer Inc.", kind: "income", categoryId: "cat-salary", amountCents: toCents(320000) },
  { id: "txn-036", accountId: "acc-checking", date: "2026-05-01", merchant: "Rent Payment", kind: "expense", categoryId: "cat-housing", amountCents: toCents(-215000) },
  { id: "txn-037", accountId: "acc-checking", date: "2026-05-03", merchant: "Whole Foods Market", kind: "expense", categoryId: "cat-groceries", amountCents: toCents(-9640) },
  { id: "txn-038", accountId: "acc-checking", date: "2026-05-05", merchant: "Shell Gas Station", kind: "expense", categoryId: "cat-transportation", amountCents: toCents(-4380) },
  { id: "txn-039", accountId: "acc-credit", date: "2026-05-07", merchant: "Netflix", kind: "expense", categoryId: "cat-subscriptions", amountCents: toCents(-1599) },
  { id: "txn-040", accountId: "acc-credit", date: "2026-05-07", merchant: "Spotify", kind: "expense", categoryId: "cat-subscriptions", amountCents: toCents(-1099) },
  { id: "txn-041", accountId: "acc-checking", date: "2026-05-10", merchant: "Trader Joe's", kind: "expense", categoryId: "cat-groceries", amountCents: toCents(-6890) },
  { id: "txn-042", accountId: "acc-checking", date: "2026-05-12", merchant: "Electric & Water Co", kind: "expense", categoryId: "cat-utilities", amountCents: toCents(-15100) },
  { id: "txn-043", accountId: "acc-credit", date: "2026-05-14", merchant: "The Local Bistro", kind: "expense", categoryId: "cat-dining", amountCents: toCents(-4920) },
  { id: "txn-044", accountId: "acc-savings", date: "2026-05-15", merchant: "Horizon Bank", kind: "income", categoryId: "cat-interest", amountCents: toCents(948) },
  { id: "txn-045", accountId: "acc-checking", date: "2026-05-16", merchant: "Transfer to Savings", kind: "transfer", movementId: "mov-transfer-2026-05", amountCents: toCents(-50000) },
  { id: "txn-046", accountId: "acc-savings", date: "2026-05-16", merchant: "Transfer from Checking", kind: "transfer", movementId: "mov-transfer-2026-05", amountCents: toCents(50000) },
  { id: "txn-047", accountId: "acc-checking", date: "2026-05-18", merchant: "Credit Card Payment", kind: "credit_card_payment", movementId: "mov-ccpay-2026-05", amountCents: toCents(-38900) },
  { id: "txn-048", accountId: "acc-credit", date: "2026-05-18", merchant: "Payment Received", kind: "credit_card_payment", movementId: "mov-ccpay-2026-05", amountCents: toCents(38900) },
  { id: "txn-049", accountId: "acc-credit", date: "2026-05-21", merchant: "Bowling Night", kind: "expense", categoryId: "cat-entertainment", amountCents: toCents(-2800) },
  { id: "txn-050", accountId: "acc-credit", date: "2026-05-23", merchant: "Refund - Returned Shoes", kind: "refund", categoryId: "cat-shopping", amountCents: toCents(4599) },
  { id: "txn-051", accountId: "acc-credit", date: "2026-05-26", merchant: "Best Buy", kind: "expense", categoryId: "cat-shopping", amountCents: toCents(-12400) },

  // ---- June 2026 ----
  { id: "txn-052", accountId: "acc-checking", date: "2026-06-01", merchant: "Employer Inc.", kind: "income", categoryId: "cat-salary", amountCents: toCents(320000) },
  { id: "txn-053", accountId: "acc-checking", date: "2026-06-01", merchant: "Rent Payment", kind: "expense", categoryId: "cat-housing", amountCents: toCents(-215000) },
  { id: "txn-054", accountId: "acc-checking", date: "2026-06-03", merchant: "Whole Foods Market", kind: "expense", categoryId: "cat-groceries", amountCents: toCents(-10120) },
  { id: "txn-055", accountId: "acc-checking", date: "2026-06-05", merchant: "Shell Gas Station", kind: "expense", categoryId: "cat-transportation", amountCents: toCents(-4650) },
  { id: "txn-056", accountId: "acc-credit", date: "2026-06-07", merchant: "Netflix", kind: "expense", categoryId: "cat-subscriptions", amountCents: toCents(-1599) },
  { id: "txn-057", accountId: "acc-checking", date: "2026-06-09", merchant: "Trader Joe's", kind: "expense", categoryId: "cat-groceries", amountCents: toCents(-7350) },
  { id: "txn-058", accountId: "acc-checking", date: "2026-06-11", merchant: "Electric & Water Co", kind: "expense", categoryId: "cat-utilities", amountCents: toCents(-16200) },
  { id: "txn-059", accountId: "acc-credit", date: "2026-06-13", merchant: "Ramen House", kind: "expense", categoryId: "cat-dining", amountCents: toCents(-3760) },
  { id: "txn-060", accountId: "acc-savings", date: "2026-06-15", merchant: "Horizon Bank", kind: "income", categoryId: "cat-interest", amountCents: toCents(962) },
  { id: "txn-061", accountId: "acc-checking", date: "2026-06-16", merchant: "Transfer to Savings", kind: "transfer", movementId: "mov-transfer-2026-06", amountCents: toCents(-50000) },
  { id: "txn-062", accountId: "acc-savings", date: "2026-06-16", merchant: "Transfer from Checking", kind: "transfer", movementId: "mov-transfer-2026-06", amountCents: toCents(50000) },
  { id: "txn-063", accountId: "acc-checking", date: "2026-06-18", merchant: "Credit Card Payment", kind: "credit_card_payment", movementId: "mov-ccpay-2026-06", amountCents: toCents(-29800) },
  { id: "txn-064", accountId: "acc-credit", date: "2026-06-18", merchant: "Payment Received", kind: "credit_card_payment", movementId: "mov-ccpay-2026-06", amountCents: toCents(29800) },
  { id: "txn-065", accountId: "acc-checking", date: "2026-06-19", merchant: "State Farm Insurance", kind: "expense", categoryId: "cat-insurance", amountCents: toCents(-61200) },
  { id: "txn-066", accountId: "acc-credit", date: "2026-06-22", merchant: "Six Flags", kind: "expense", categoryId: "cat-entertainment", amountCents: toCents(-8900) },
  { id: "txn-067", accountId: "acc-checking", date: "2026-06-25", merchant: "Home Depot", kind: "expense", categoryId: "cat-shopping", amountCents: toCents(-6540) },

  // ---- July 2026 ----
  { id: "txn-068", accountId: "acc-checking", date: "2026-07-01", merchant: "Employer Inc.", kind: "income", categoryId: "cat-salary", amountCents: toCents(320000) },
  { id: "txn-069", accountId: "acc-checking", date: "2026-07-01", merchant: "Rent Payment", kind: "expense", categoryId: "cat-housing", amountCents: toCents(-215000) },
  { id: "txn-070", accountId: "acc-checking", date: "2026-07-03", merchant: "Whole Foods Market", kind: "expense", categoryId: "cat-groceries", amountCents: toCents(-9980) },
  { id: "txn-071", accountId: "acc-checking", date: "2026-07-06", merchant: "Shell Gas Station", kind: "expense", categoryId: "cat-transportation", amountCents: toCents(-4720) },
  { id: "txn-072", accountId: "acc-credit", date: "2026-07-07", merchant: "Netflix", kind: "expense", categoryId: "cat-subscriptions", amountCents: toCents(-1599) },
  { id: "txn-073", accountId: "acc-checking", date: "2026-07-10", merchant: "Trader Joe's", kind: "expense", categoryId: "cat-groceries", amountCents: toCents(-6980) },
  { id: "txn-074", accountId: "acc-checking", date: "2026-07-12", merchant: "Electric & Water Co", kind: "expense", categoryId: "cat-utilities", amountCents: toCents(-17450) },
  { id: "txn-075", accountId: "acc-credit", date: "2026-07-14", merchant: "Taco Truck", kind: "expense", categoryId: "cat-dining", amountCents: toCents(-2340) },
  { id: "txn-076", accountId: "acc-savings", date: "2026-07-15", merchant: "Horizon Bank", kind: "income", categoryId: "cat-interest", amountCents: toCents(975) },
  { id: "txn-077", accountId: "acc-checking", date: "2026-07-16", merchant: "Transfer to Savings", kind: "transfer", movementId: "mov-transfer-2026-07", amountCents: toCents(-50000) },
  { id: "txn-078", accountId: "acc-savings", date: "2026-07-16", merchant: "Transfer from Checking", kind: "transfer", movementId: "mov-transfer-2026-07", amountCents: toCents(50000) },
  { id: "txn-079", accountId: "acc-checking", date: "2026-07-18", merchant: "Credit Card Payment", kind: "credit_card_payment", movementId: "mov-ccpay-2026-07", amountCents: toCents(-35600) },
  { id: "txn-080", accountId: "acc-credit", date: "2026-07-18", merchant: "Payment Received", kind: "credit_card_payment", movementId: "mov-ccpay-2026-07", amountCents: toCents(35600) },
  { id: "txn-081", accountId: "acc-credit", date: "2026-07-20", merchant: "Water Park", kind: "expense", categoryId: "cat-entertainment", amountCents: toCents(-5400) },
  { id: "txn-082", accountId: "acc-checking", date: "2026-07-23", merchant: "Dentist Office", kind: "expense", categoryId: "cat-healthcare", amountCents: toCents(-22000) },
  { id: "txn-083", accountId: "acc-credit", date: "2026-07-27", merchant: "Nordstrom", kind: "expense", categoryId: "cat-shopping", amountCents: toCents(-9870) },
  { id: "txn-084", accountId: "acc-checking", date: "2026-07-31", merchant: "Grocery Store", kind: "expense", categoryId: "cat-groceries", amountCents: toCents(-8734) }, // day before the month boundary

  // ---- August 2026 (current month; MOCK_TODAY = 2026-08-20) ----
  { id: "txn-085", accountId: "acc-checking", date: "2026-08-01", merchant: "Rent Payment", kind: "expense", categoryId: "cat-housing", amountCents: toCents(-215000) }, // month boundary
  { id: "txn-086", accountId: "acc-checking", date: "2026-08-01", merchant: "Employer Inc.", kind: "income", categoryId: "cat-salary", amountCents: toCents(320000) }, // same-day as rent
  { id: "txn-087", accountId: "acc-checking", date: "2026-08-03", merchant: "Whole Foods Market", kind: "expense", categoryId: "cat-groceries", amountCents: toCents(-10850) },
  { id: "txn-088", accountId: "acc-credit", date: "2026-08-05", merchant: "Refund - Returned Item", kind: "refund", categoryId: "cat-shopping", amountCents: toCents(4599) },
  { id: "txn-089", accountId: "acc-checking", date: "2026-08-06", merchant: "Trader Joe's", kind: "expense", categoryId: "cat-groceries", amountCents: toCents(-7200) },
  { id: "txn-090", accountId: "acc-checking", date: "2026-08-08", merchant: "Shell Gas Station", kind: "expense", categoryId: "cat-transportation", amountCents: toCents(-4900) },
  { id: "txn-091", accountId: "acc-credit", date: "2026-08-10", merchant: "Online Subscription", kind: "expense", categoryId: "cat-subscriptions", amountCents: toCents(-1499) },
  { id: "txn-092", accountId: "acc-credit", date: "2026-08-10", merchant: "The Local Bistro", kind: "expense", categoryId: "cat-dining", amountCents: toCents(-5200) },
  { id: "txn-093", accountId: "acc-checking", date: "2026-08-11", merchant: "Target", kind: "expense", categoryId: "cat-shopping", amountCents: toCents(-3200) }, // nets negative vs. the Aug 5 refund
  { id: "txn-094", accountId: "acc-cash", date: "2026-08-12", merchant: "Voided Purchase", kind: "expense", amountCents: toCents(0) }, // zero-amount, deliberately uncategorized
  { id: "txn-095", accountId: "acc-credit", date: "2026-08-13", merchant: "Sushi Place", kind: "expense", categoryId: "cat-dining", amountCents: toCents(-6100) },
  { id: "txn-096", accountId: "acc-checking", date: "2026-08-14", merchant: "Electric & Water Co", kind: "expense", categoryId: "cat-utilities", amountCents: toCents(-16800) },
  { id: "txn-097", accountId: "acc-savings", date: "2026-08-15", merchant: "Horizon Bank", kind: "income", categoryId: "cat-interest", amountCents: toCents(988) },
  { id: "txn-098", accountId: "acc-checking", date: "2026-08-16", merchant: "Transfer to Savings", kind: "transfer", movementId: "mov-transfer-2026-08", amountCents: toCents(-50000) },
  { id: "txn-099", accountId: "acc-savings", date: "2026-08-16", merchant: "Transfer from Checking", kind: "transfer", movementId: "mov-transfer-2026-08", amountCents: toCents(50000) },
  { id: "txn-100", accountId: "acc-credit", date: "2026-08-16", merchant: "Ramen House", kind: "expense", categoryId: "cat-dining", amountCents: toCents(-8900) },
  { id: "txn-101", accountId: "acc-checking", date: "2026-08-18", merchant: "Credit Card Payment", kind: "credit_card_payment", movementId: "mov-ccpay-2026-08", amountCents: toCents(-42000) },
  { id: "txn-102", accountId: "acc-credit", date: "2026-08-18", merchant: "Payment Received", kind: "credit_card_payment", movementId: "mov-ccpay-2026-08", amountCents: toCents(42000) },
  { id: "txn-103", accountId: "acc-credit", date: "2026-08-18", merchant: "Steakhouse", kind: "expense", categoryId: "cat-dining", amountCents: toCents(-7450) }, // pushes Dining over its $250 August budget
  { id: "txn-104", accountId: "acc-credit", date: "2026-08-19", merchant: "Cinema Night", kind: "expense", categoryId: "cat-entertainment", amountCents: toCents(-3600) },
]);
