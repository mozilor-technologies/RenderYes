/**
 * A finance capability catalog we own, for evaluating the planner.
 *
 * Deliberately *not* a customer's production catalog. Evaluation needs a
 * fixture that is stable (a real catalog changes underneath every baseline),
 * safe to commit, and shaped to actually exercise the planner rather than
 * whatever a given host happens to expose.
 *
 * Sized to be a genuine test. A three-capability catalog measures nothing —
 * the planner cannot get a choice wrong when there is no choice. This has 16
 * capabilities across 5 result shapes, several deliberate near-misses (spend
 * by category vs by merchant; cashflow vs net-worth trend; overdue invoices vs
 * all invoices), two join relationships, and filter/sort/aggregate support on
 * the collections. Those near-misses are the point: they are where capability
 * selection is a real decision rather than a lookup.
 *
 * Nothing here ships. It lives under `eval/`, which no package's `files` array
 * includes.
 */

const money = (label) => ({ label, semanticType: "money" });
const text = (label) => ({ label, semanticType: "text" });
const identifier = (label) => ({ label, semanticType: "identifier" });
const quantity = (label) => ({ label, semanticType: "quantity" });
const status = (label) => ({ label, semanticType: "status" });
const date = (label) => ({ label, semanticType: "date" });
const percentage = (label) => ({ label, semanticType: "percentage" });

const dataTypes = [
  {
    id: "Account",
    version: "1.0.0",
    description: "A bank or brokerage account the signed-in customer holds.",
    schema: { type: "object" },
    matchKey: "accountId",
    fields: {
      accountId: identifier("Account ID"),
      name: text("Account name"),
      institution: text("Institution"),
      type: status("Account type"),
      balance: money("Current balance"),
      currency: text("Currency"),
      openedAt: date("Opened"),
    },
  },
  {
    id: "Transaction",
    version: "1.0.0",
    description: "A single posted transaction on one of the customer's accounts.",
    schema: { type: "object" },
    matchKey: "transactionId",
    fields: {
      transactionId: identifier("Transaction ID"),
      accountId: identifier("Account ID"),
      merchantId: identifier("Merchant ID"),
      description: text("Description"),
      amount: money("Amount"),
      category: status("Category"),
      status: status("Status"),
      postedAt: date("Posted"),
    },
  },
  {
    id: "Merchant",
    version: "1.0.0",
    description: "A merchant a transaction was made with.",
    schema: { type: "object" },
    matchKey: "merchantId",
    fields: {
      merchantId: identifier("Merchant ID"),
      name: text("Merchant"),
      sector: status("Sector"),
      country: text("Country"),
    },
  },
  {
    id: "Holding",
    version: "1.0.0",
    description: "A position held in a brokerage account.",
    schema: { type: "object" },
    matchKey: "holdingId",
    fields: {
      holdingId: identifier("Holding ID"),
      accountId: identifier("Account ID"),
      symbol: identifier("Symbol"),
      name: text("Instrument"),
      quantity: quantity("Units"),
      marketValue: money("Market value"),
      unrealisedGain: money("Unrealised gain"),
    },
  },
  {
    id: "PortfolioSummary",
    version: "1.0.0",
    description: "Aggregate position across every brokerage account.",
    schema: { type: "object" },
    fields: {
      totalValue: money("Total value"),
      totalGain: money("Total gain"),
      returnRate: percentage("Return rate"),
      positionCount: quantity("Positions"),
    },
  },
  {
    id: "CategorySpend",
    version: "1.0.0",
    description: "Spend totalled by transaction category.",
    schema: { type: "object" },
    fields: {
      category: status("Category"),
      total: money("Total spent"),
      transactionCount: quantity("Transactions"),
      shareOfSpend: percentage("Share of spend"),
    },
  },
  {
    id: "MerchantSpend",
    version: "1.0.0",
    description: "Spend totalled by merchant.",
    schema: { type: "object" },
    fields: {
      merchantId: identifier("Merchant ID"),
      merchant: text("Merchant"),
      total: money("Total spent"),
      transactionCount: quantity("Transactions"),
    },
  },
  {
    id: "CashflowPoint",
    version: "1.0.0",
    description: "Money in and out over time.",
    schema: { type: "object" },
    fields: {
      period: date("Period"),
      inflow: money("Money in"),
      outflow: money("Money out"),
      net: money("Net"),
    },
  },
  {
    id: "NetWorthPoint",
    version: "1.0.0",
    description: "Total assets minus liabilities over time.",
    schema: { type: "object" },
    fields: {
      period: date("Period"),
      assets: money("Assets"),
      liabilities: money("Liabilities"),
      netWorth: money("Net worth"),
    },
  },
  {
    id: "Budget",
    version: "1.0.0",
    description: "A spending limit the customer set for a category.",
    schema: { type: "object" },
    matchKey: "budgetId",
    fields: {
      budgetId: identifier("Budget ID"),
      category: status("Category"),
      limit: money("Limit"),
      spent: money("Spent"),
      remaining: money("Remaining"),
      period: text("Period"),
    },
  },
  {
    id: "Invoice",
    version: "1.0.0",
    description: "An invoice issued to the customer.",
    schema: { type: "object" },
    matchKey: "invoiceId",
    fields: {
      invoiceId: identifier("Invoice ID"),
      counterparty: text("Counterparty"),
      amount: money("Amount"),
      status: status("Status"),
      issuedAt: date("Issued"),
      dueAt: date("Due"),
      daysOverdue: quantity("Days overdue"),
    },
  },
  {
    id: "Subscription",
    version: "1.0.0",
    description: "A recurring payment detected from transaction history.",
    schema: { type: "object" },
    matchKey: "subscriptionId",
    fields: {
      subscriptionId: identifier("Subscription ID"),
      merchant: text("Merchant"),
      amount: money("Amount"),
      cadence: status("Cadence"),
      nextChargeAt: date("Next charge"),
      annualCost: money("Annual cost"),
    },
  },
];

/** Query features a collection advertises. Absent means the planner may not ask. */
const listSupport = (fields, options = {}) => ({
  filterFields: fields,
  sortFields: fields,
  pagination: true,
  ...(options.groupFields ? { groupFields: options.groupFields } : {}),
  ...(options.aggregates ? { aggregates: options.aggregates } : {}),
});

const capability = (id, purpose, dataTypeId, shape, extra = {}) => ({
  id,
  version: "1.0.0",
  purpose,
  kind: "query",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  outputSchema: { type: "object" },
  output: { dataTypeId, shape },
  requiredSessionKeys: [],
  sourceIds: ["finance-core"],
  policy: { authentication: "session" },
  constraints: { maximumRows: 500 },
  ...extra,
});

const capabilities = [
  capability(
    "accounts.list",
    "List every account the customer holds, with balances.",
    "Account",
    "collection",
    {
      supports: listSupport(["type", "institution", "balance", "currency"]),
    },
  ),
  capability("accounts.get", "Get one account by its identifier.", "Account", "entity"),

  capability(
    "transactions.list",
    "List posted transactions, filterable by account, category, status, amount, and date.",
    "Transaction",
    "collection",
    {
      supports: listSupport(["accountId", "category", "status", "amount", "postedAt"], {
        groupFields: ["category", "status"],
        aggregates: ["count", "sum", "average"],
      }),
    },
  ),
  capability(
    "transactions.search",
    "Find transactions matching free text in their description.",
    "Transaction",
    "search-results",
    { supports: listSupport(["category", "amount", "postedAt"]) },
  ),

  capability(
    "merchants.list",
    "List merchants the customer has transacted with.",
    "Merchant",
    "collection",
    {
      supports: listSupport(["sector", "country"]),
    },
  ),

  capability(
    "holdings.list",
    "List investment positions across brokerage accounts.",
    "Holding",
    "collection",
    {
      supports: listSupport(["accountId", "symbol", "marketValue", "unrealisedGain"], {
        aggregates: ["sum", "average"],
      }),
    },
  ),
  capability(
    "portfolio.summary",
    "Total portfolio value, gain, and return rate across all investments.",
    "PortfolioSummary",
    "metric",
  ),

  // Near-miss pair: same question shape, different grouping dimension.
  capability(
    "spend.byCategory",
    "Total spending grouped by category.",
    "CategorySpend",
    "collection",
    {
      supports: listSupport(["category", "total"]),
    },
  ),
  capability(
    "spend.byMerchant",
    "Total spending grouped by merchant.",
    "MerchantSpend",
    "collection",
    {
      supports: listSupport(["merchant", "total"]),
    },
  ),

  // Near-miss pair: both are trends over time, measuring different things.
  capability(
    "cashflow.trend",
    "Money in versus money out over time.",
    "CashflowPoint",
    "time-series",
  ),
  capability(
    "netWorth.trend",
    "Assets minus liabilities over time.",
    "NetWorthPoint",
    "time-series",
  ),

  capability(
    "budgets.list",
    "List category budgets with what has been spent against them.",
    "Budget",
    "collection",
    {
      supports: listSupport(["category", "period", "remaining"]),
    },
  ),

  // Near-miss pair: one is a filtered view of the other, and the planner may
  // legitimately answer either with a filter or with the dedicated capability.
  capability(
    "invoices.list",
    "List invoices issued to the customer.",
    "Invoice",
    "collection",
    {
      supports: listSupport(["status", "counterparty", "amount", "dueAt"], {
        aggregates: ["count", "sum"],
      }),
    },
  ),
  capability(
    "invoices.overdue",
    "List only invoices that are past their due date, with how many days overdue.",
    "Invoice",
    "collection",
    { supports: listSupport(["counterparty", "amount", "daysOverdue"]) },
  ),

  capability(
    "subscriptions.list",
    "List recurring payments detected from transaction history.",
    "Subscription",
    "collection",
    { supports: listSupport(["merchant", "cadence", "amount", "annualCost"]) },
  ),
  capability(
    "subscriptions.upcoming",
    "List recurring payments due to charge in the near future.",
    "Subscription",
    "collection",
    { supports: listSupport(["merchant", "nextChargeAt", "amount"]) },
  ),
];

export const financeCatalog = {
  schemaVersion: "1.0",
  id: "finance-eval",
  version: "1.0.0",
  description:
    "Personal finance reads for evaluation. A fixture we control, not a production catalog.",
  dataTypes,
  sources: [{ id: "finance-core", label: "Finance Core API" }],
  capabilities,
  relationships: [
    {
      id: "transaction-merchant",
      description: "A transaction was made with a merchant.",
      from: { dataTypeId: "Transaction", field: "merchantId" },
      to: { dataTypeId: "Merchant", field: "merchantId" },
      cardinality: "many-to-one",
    },
    {
      id: "holding-account",
      description: "A holding sits in an account.",
      from: { dataTypeId: "Holding", field: "accountId" },
      to: { dataTypeId: "Account", field: "accountId" },
      cardinality: "many-to-one",
    },
  ],
};
