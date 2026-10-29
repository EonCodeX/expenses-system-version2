const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'bills.json');

function load() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function save(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function list() {
  const { bills } = load();
  const todayStr = today();
  console.log('\n=== BILLS & LOANS ===\n');
  bills.forEach(b => {
    const overdue = !b.paid && b.dueDate < todayStr;
    const status = b.paid
      ? `PAID on ${b.paidDate}`
      : overdue ? 'OVERDUE' : 'PENDING';
    console.log(`[${b.id}] ${b.name}`);
    console.log(`    Amount : ₱${b.amount.toLocaleString()}`);
    console.log(`    Due    : ${b.dueDate}`);
    console.log(`    Status : ${status}`);
    console.log('');
  });
}

function add(name, amount, dueDate) {
  if (!name || !amount || !dueDate) {
    console.log('Usage: node bills.js add "<name>" <amount> <YYYY-MM-DD>');
    return;
  }
  const data = load();
  const bill = {
    id: data.nextId++,
    name,
    amount: parseFloat(amount),
    dueDate,
    paid: false,
    paidDate: null
  };
  data.bills.push(bill);
  save(data);
  console.log(`Added: [${bill.id}] ${bill.name} — ₱${bill.amount} due ${bill.dueDate}`);
}

function pay(id) {
  if (!id) {
    console.log('Usage: node bills.js pay <id>');
    return;
  }
  const data = load();
  const bill = data.bills.find(b => b.id === parseInt(id));
  if (!bill) {
    console.log(`No bill found with id ${id}`);
    return;
  }
  if (bill.paid) {
    console.log(`${bill.name} is already marked as paid.`);
    return;
  }
  bill.paid = true;
  bill.paidDate = today();
  save(data);
  console.log(`Marked as paid: ${bill.name}`);
}

function check() {
  const { bills } = load();
  const todayStr = today();
  const overdue = bills.filter(b => !b.paid && b.dueDate < todayStr);
  if (overdue.length === 0) {
    console.log('No overdue bills. You are all caught up!');
    return;
  }
  console.log(`\nFound ${overdue.length} overdue bill(s):`);
  overdue.forEach(b => console.log(`  - [${b.id}] ${b.name} (due ${b.dueDate})`));
}

const [,, command, ...args] = process.argv;

switch (command) {
  case 'list':   list(); break;
  case 'add':    add(args[0], args[1], args[2]); break;
  case 'pay':    pay(args[0]); break;
  case 'check':  check(); break;
  default:
    console.log(`
Bill & Loan Tracker
-------------------
Commands:
  node bills.js list                          List all bills
  node bills.js add "<name>" <amount> <date>  Add a new bill
  node bills.js pay <id>                      Mark bill as paid
  node bills.js check                         Check for overdue bills
    `);
}
