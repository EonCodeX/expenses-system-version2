const express  = require('express');
const session  = require('express-session');
const crypto   = require('crypto');
const xlsx     = require('xlsx');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');

const app            = express();
const PORT           = 3000;
const EXCEL_PATH     = path.join(__dirname, 'bills.xlsx');   // master + admin data
const DATA_DIR       = path.join(__dirname, 'data');          // per-group data files
const SHEET          = 'Bills';
const LOANS_SHEET    = 'Loans';
const LOAN_PMT_SHEET = 'Loan Payments';
const INCOME_SHEET   = 'Income';
const USERS_SHEET    = 'Users';
const GROUPS_SHEET   = 'Groups';
const UPLOADS_DIR    = path.join(__dirname, 'uploads');
const ENCRYPT_KEY    = '7f3a9c2e1d8b054f6a4e7c3b9d2f1e085c4b7a3e9d1f208a6e4c7b3a9d2f108e';

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(DATA_DIR))    fs.mkdirSync(DATA_DIR);

// ── Write queue: serialises all read-modify-write ops per file ──
const fileQueues = {};
function withFile(file, fn) {
  if (!fileQueues[file]) fileQueues[file] = Promise.resolve();
  const task = fileQueues[file].then(() => fn());
  fileQueues[file] = task.catch(() => {});
  return task;
}

app.use(express.json({ limit: '10mb' }));
app.use(session({
  secret: 'expense-monitor-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));
app.use('/uploads', express.static(UPLOADS_DIR));

// ── Encrypt all /api JSON responses (AES-256-GCM) ──
app.use('/api', (req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = (data) => origJson({ enc: encryptPayload(JSON.stringify(data)) });
  next();
});

// ════════════════════════════════════════
//  GROUP HELPERS
// ════════════════════════════════════════

function getGroupFile(groupCode) {
  if (!groupCode || groupCode === 'admin') return EXCEL_PATH;
  return path.join(DATA_DIR, `group_${groupCode}.xlsx`);
}

function ensureGroupFile(code) {
  if (!code || code === 'admin') return;
  const file = getGroupFile(code);
  if (fs.existsSync(file)) return;
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([[
    'ID','Bill Name','Category','Amount','Due Date','Status','Payment Date','Notes','Attachment','Recurrence'
  ]]), SHEET);
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([[
    'ID','Loan Name','Lender','Principal','Monthly Payment','Terms','Start Date','Due Day','Notes'
  ]]), LOANS_SHEET);
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([[
    'ID','Loan ID','Amount','Payment Date','Notes'
  ]]), LOAN_PMT_SHEET);
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([[
    'ID','Description','Category','Amount','Date','Notes'
  ]]), INCOME_SHEET);
  xlsx.writeFile(wb, file);
  console.log(`[GROUP] Created data file: group_${code}.xlsx`);
}

function readGroups() {
  const wb = xlsx.readFile(EXCEL_PATH);
  if (!wb.Sheets[GROUPS_SHEET]) return [];
  return xlsx.utils.sheet_to_json(wb.Sheets[GROUPS_SHEET], { defval: '' });
}

function writeGroups(rows) {
  const wb = xlsx.readFile(EXCEL_PATH);
  wb.Sheets[GROUPS_SHEET] = xlsx.utils.json_to_sheet(rows, {
    header: ['ID','Name','Code','Description','CreatedAt']
  });
  if (!wb.SheetNames.includes(GROUPS_SHEET)) wb.SheetNames.push(GROUPS_SHEET);
  xlsx.writeFile(wb, EXCEL_PATH);
}

// ════════════════════════════════════════
//  USER HELPERS
// ════════════════════════════════════════

function readUsers() {
  if (!fs.existsSync(EXCEL_PATH)) return [];
  const wb = xlsx.readFile(EXCEL_PATH);
  if (!wb.Sheets[USERS_SHEET]) return [];
  return xlsx.utils.sheet_to_json(wb.Sheets[USERS_SHEET], { defval: '' });
}

function writeUsers(rows) {
  const wb = xlsx.readFile(EXCEL_PATH);
  wb.Sheets[USERS_SHEET] = xlsx.utils.json_to_sheet(rows, {
    header: ['ID','Username','Salt','Hash','Status','GroupCode','CreatedAt']
  });
  if (!wb.SheetNames.includes(USERS_SHEET)) wb.SheetNames.push(USERS_SHEET);
  xlsx.writeFile(wb, EXCEL_PATH);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHmac('sha256', salt).update(password).digest('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, storedHash) {
  const hash = crypto.createHmac('sha256', salt).update(password).digest('hex');
  return hash === storedHash;
}

function encryptPayload(text) {
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENCRYPT_KEY, 'hex'), iv);
  const ct     = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + ct.toString('hex');
}

// ════════════════════════════════════════
//  AUTH MIDDLEWARE
// ════════════════════════════════════════

function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  if (req.path.startsWith('/api')) return res.status(401).json({ error: 'Not logged in' });
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(403).json({ error: 'Admin only' });
}

// Sets req.dataFile for all data API calls based on session group
function setDataFile(req, res, next) {
  req.dataFile = req.session.dataFile || EXCEL_PATH;
  next();
}

// ════════════════════════════════════════
//  PUBLIC PAGES
// ════════════════════════════════════════

app.get('/login',    (req, res) => {
  if (req.session && req.session.loggedIn) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'login.html'));
});
app.get('/register', (req, res) => {
  if (req.session && req.session.loggedIn) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'register.html'));
});

// ════════════════════════════════════════
//  PUBLIC API (no auth required)
// ════════════════════════════════════════

// Groups list for registration dropdown (only Name + Code, no sensitive data)
app.get('/api/groups/public', (req, res) => {
  try {
    const groups = readGroups().map(g => ({ ID: g.ID, Name: g.Name, Code: g.Code }));
    res.json(groups);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Login rate limiter: max 4 attempts, 30-min lockout ──
const loginAttempts = {}; // key: username_lower → { count, lockedUntil }
const MAX_ATTEMPTS   = 4;
const LOCKOUT_MS     = 5000; // 5minutes

function checkLoginLock(username) {
  const key  = username.toLowerCase();
  const rec  = loginAttempts[key];
  if (!rec) return null;
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) {
    const mins = Math.ceil((rec.lockedUntil - Date.now()) / 60000);
    return `Too many failed attempts. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.`;
  }
  return null;
}

function recordFailedLogin(username) {
  const key = username.toLowerCase();
  if (!loginAttempts[key]) loginAttempts[key] = { count: 0, lockedUntil: null };
  loginAttempts[key].count++;
  if (loginAttempts[key].count >= MAX_ATTEMPTS) {
    loginAttempts[key].lockedUntil = Date.now() + LOCKOUT_MS;
    loginAttempts[key].count = 0;
  }
}

function clearLoginLock(username) {
  delete loginAttempts[username.toLowerCase()];
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

  const lockMsg = checkLoginLock(username);
  if (lockMsg) return res.status(429).json({ error: lockMsg });

  const users = readUsers();
  const user  = users.find(u => u.Username.toLowerCase() === username.toLowerCase());
  if (!user || !verifyPassword(password, user.Salt, user.Hash)) {
    recordFailedLogin(username);
    const rec = loginAttempts[username.toLowerCase()];
    const remaining = MAX_ATTEMPTS - (rec ? rec.count : 0);
    const hint = remaining > 0 ? ` (${remaining} attempt${remaining !== 1 ? 's' : ''} left)` : '';
    return res.status(401).json({ error: `Invalid username or password${hint}` });
  }
  clearLoginLock(username);
  const status = user.Status || 'Active';
  if (status === 'Pending')
    return res.status(403).json({ error: 'Your account is pending admin approval. Please wait.' });
  if (status === 'Rejected')
    return res.status(403).json({ error: 'Your account request was rejected. Contact the admin.' });
  const groupCode = user.GroupCode || 'admin';
  const groups    = readGroups();
  const group     = groups.find(g => g.Code === groupCode);
  req.session.loggedIn   = true;
  req.session.user       = user.Username;
  req.session.isAdmin    = user.Username.toLowerCase() === 'admin';
  req.session.groupCode  = groupCode;
  req.session.groupName  = group ? group.Name : groupCode;
  req.session.dataFile   = getGroupFile(groupCode);
  res.json({ ok: true, isAdmin: req.session.isAdmin, groupName: req.session.groupName });
});

app.post('/api/register', (req, res) => {
  const { username, password, groupCode } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  if (!groupCode)              return res.status(400).json({ error: 'Group is required' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username))
    return res.status(400).json({ error: 'Username must be 3–20 characters (letters, numbers, _ only)' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const groups = readGroups();
  if (!groups.some(g => g.Code === groupCode))
    return res.status(400).json({ error: 'Invalid group code. Contact admin.' });
  const users = readUsers();
  if (users.some(u => u.Username.toLowerCase() === username.toLowerCase()))
    return res.status(409).json({ error: 'Username already taken' });
  const { salt, hash } = hashPassword(password);
  const newUser = {
    ID:        users.length ? Math.max(...users.map(u => Number(u.ID) || 0)) + 1 : 1,
    Username:  username,
    Salt:      salt,
    Hash:      hash,
    Status:    'Pending',
    GroupCode: groupCode,
    CreatedAt: new Date().toISOString()
  };
  users.push(newUser);
  writeUsers(users);
  console.log(`[AUTH] Registered: ${username} → group: ${groupCode}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Change own password (any logged-in user)
app.post('/api/change-password', (req, res) => {
  if (!req.session.loggedIn) return res.status(401).json({ error: 'Not logged in' });
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'All fields are required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  const users = readUsers();
  const idx   = users.findIndex(u => u.Username.toLowerCase() === req.session.user.toLowerCase());
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  if (!verifyPassword(currentPassword, users[idx].Salt, users[idx].Hash))
    return res.status(401).json({ error: 'Current password is incorrect' });
  const { salt, hash } = hashPassword(newPassword);
  users[idx].Salt = salt;
  users[idx].Hash = hash;
  writeUsers(users);
  console.log(`[AUTH] Password changed: ${req.session.user}`);
  res.json({ ok: true });
});

// Admin resets another user's password (no current password needed)
app.put('/api/users/:id/reset-password', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const users = readUsers();
  const idx   = users.findIndex(u => String(u.ID) === String(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  const { salt, hash } = hashPassword(newPassword);
  users[idx].Salt = salt;
  users[idx].Hash = hash;
  writeUsers(users);
  console.log(`[AUTH] Admin reset password for: ${users[idx].Username}`);
  res.json({ ok: true });
});

// ════════════════════════════════════════
//  PROTECTED PAGES
// ════════════════════════════════════════

app.get('/',           requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// All /api routes below require login + sets dataFile
app.use('/api', requireAuth, setDataFile);

// ════════════════════════════════════════
//  CURRENT USER INFO
// ════════════════════════════════════════

app.get('/api/me', (req, res) => {
  res.json({
    username:  req.session.user,
    isAdmin:   req.session.isAdmin   || false,
    groupCode: req.session.groupCode || 'admin',
    groupName: req.session.groupName || 'Admin'
  });
});

// Admin switches active group to view/manage that group's data
app.post('/api/switch-group', requireAdmin, (req, res) => {
  const { groupCode } = req.body;
  if (!groupCode) return res.status(400).json({ error: 'groupCode required' });
  if (groupCode === '__all__') {
    req.session.groupCode = '__all__';
    req.session.groupName = 'All Groups';
    req.session.dataFile  = '__all__';
    return res.json({ ok: true, groupName: 'All Groups' });
  }
  if (groupCode === 'admin') {
    req.session.groupCode = 'admin';
    req.session.groupName = 'Admin (my data)';
    req.session.dataFile  = EXCEL_PATH;
    return res.json({ ok: true, groupName: 'Admin (my data)' });
  }
  const groups = readGroups();
  const group  = groups.find(g => g.Code === groupCode);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  req.session.groupCode = groupCode;
  req.session.groupName = group.Name;
  req.session.dataFile  = getGroupFile(groupCode);
  res.json({ ok: true, groupName: group.Name });
});

// ════════════════════════════════════════
//  ADMIN: GROUPS MANAGEMENT
// ════════════════════════════════════════

app.get('/api/groups', requireAdmin, (req, res) => {
  try {
    const groups = readGroups();
    const users  = readUsers();
    const result = groups.map(g => ({
      ...g,
      memberCount: users.filter(u => u.GroupCode === g.Code).length
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/groups', requireAdmin, async (req, res) => {
  try {
    await withFile(EXCEL_PATH, () => {
      const { name, code, description } = req.body;
      if (!name || !code) return res.status(400).json({ error: 'Name and code are required' });
      if (!/^[a-zA-Z0-9_-]{2,20}$/.test(code))
        return res.status(400).json({ error: 'Code must be 2–20 characters (letters, numbers, _ -)' });
      const groups = readGroups();
      if (groups.some(g => g.Code.toLowerCase() === code.toLowerCase()))
        return res.status(409).json({ error: 'Group code already exists' });
      const newGroup = {
        ID:          groups.length ? Math.max(...groups.map(g => Number(g.ID) || 0)) + 1 : 1,
        Name:        name,
        Code:        code,
        Description: description || '',
        CreatedAt:   new Date().toISOString()
      };
      groups.push(newGroup);
      writeGroups(groups);
      ensureGroupFile(code);
      console.log(`[GROUP] Created group: ${name} (${code})`);
      res.json(newGroup);
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/groups/:id', requireAdmin, async (req, res) => {
  try {
    await withFile(EXCEL_PATH, () => {
      const groups = readGroups();
      const idx    = groups.findIndex(g => String(g.ID) === String(req.params.id));
      if (idx === -1) return res.status(404).json({ error: 'Group not found' });
      groups[idx] = { ...groups[idx], Name: req.body.name || groups[idx].Name, Description: req.body.description ?? groups[idx].Description };
      writeGroups(groups);
      res.json(groups[idx]);
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/groups/:id', requireAdmin, async (req, res) => {
  try {
    await withFile(EXCEL_PATH, () => {
      const groups = readGroups();
      const group  = groups.find(g => String(g.ID) === String(req.params.id));
      if (!group) return res.status(404).json({ error: 'Group not found' });
      const users = readUsers();
      if (users.some(u => u.GroupCode === group.Code))
        return res.status(400).json({ error: 'Cannot delete a group that has members' });
      writeGroups(groups.filter(g => String(g.ID) !== String(req.params.id)));
      res.json({ ok: true });
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
//  ADMIN: USER MANAGEMENT
// ════════════════════════════════════════

app.get('/api/users', requireAdmin, (req, res) => {
  const groups = readGroups();
  const users  = readUsers().map(u => {
    const g = groups.find(g => g.Code === u.GroupCode);
    return {
      ID:        u.ID,
      Username:  u.Username,
      Status:    u.Status    || 'Active',
      GroupCode: u.GroupCode || 'admin',
      GroupName: g ? g.Name : (u.GroupCode === 'admin' ? 'Admin' : u.GroupCode || '—'),
      CreatedAt: u.CreatedAt || ''
    };
  });
  res.json(users);
});

app.put('/api/users/:id/approve', requireAdmin, (req, res) => {
  const users = readUsers();
  const idx   = users.findIndex(u => String(u.ID) === String(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  users[idx].Status = 'Active';
  writeUsers(users);
  console.log(`[AUTH] Approved: ${users[idx].Username}`);
  res.json({ ok: true });
});

app.put('/api/users/:id/reject', requireAdmin, (req, res) => {
  const users = readUsers();
  const idx   = users.findIndex(u => String(u.ID) === String(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  users[idx].Status = 'Rejected';
  writeUsers(users);
  console.log(`[AUTH] Rejected: ${users[idx].Username}`);
  res.json({ ok: true });
});

app.put('/api/users/:id/group', requireAdmin, (req, res) => {
  const { groupCode } = req.body;
  if (!groupCode) return res.status(400).json({ error: 'groupCode is required' });
  const groups = readGroups();
  if (groupCode !== 'admin' && !groups.some(g => g.Code === groupCode))
    return res.status(400).json({ error: 'Invalid group code' });
  const users = readUsers();
  const idx   = users.findIndex(u => String(u.ID) === String(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  users[idx].GroupCode = groupCode;
  writeUsers(users);
  console.log(`[AUTH] Moved ${users[idx].Username} → group: ${groupCode}`);
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  let users = readUsers();
  const user = users.find(u => String(u.ID) === String(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.Username.toLowerCase() === 'admin') return res.status(400).json({ error: 'Cannot delete admin' });
  writeUsers(users.filter(u => String(u.ID) !== String(req.params.id)));
  res.json({ ok: true });
});

// ════════════════════════════════════════
//  STATIC FILES
// ════════════════════════════════════════

app.use(express.static(__dirname));

// ════════════════════════════════════════
//  MULTER
// ════════════════════════════════════════

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `bill-${req.params.id}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ════════════════════════════════════════
//  FILE INIT
// ════════════════════════════════════════

function initFile() {
  if (!fs.existsSync(EXCEL_PATH)) {
    const { salt, hash } = hashPassword('admin123');
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([[
      'ID','Bill Name','Category','Amount','Due Date','Status','Payment Date','Notes','Attachment','Recurrence'
    ]]), SHEET);
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([[
      'ID','Loan Name','Lender','Principal','Monthly Payment','Terms','Start Date','Due Day','Notes'
    ]]), LOANS_SHEET);
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([[
      'ID','Loan ID','Amount','Payment Date','Notes'
    ]]), LOAN_PMT_SHEET);
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([[
      'ID','Description','Category','Amount','Date','Notes'
    ]]), INCOME_SHEET);
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(
      [{ ID: 1, Username: 'admin', Salt: salt, Hash: hash, Status: 'Active', GroupCode: 'admin', CreatedAt: new Date().toISOString() }],
      { header: ['ID','Username','Salt','Hash','Status','GroupCode','CreatedAt'] }
    ), USERS_SHEET);
    const now = new Date().toISOString();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(
      [
        { ID: 1, Name: 'Neo',  Code: 'neo',  Description: 'Neo Household',  CreatedAt: now },
        { ID: 2, Name: 'Nova', Code: 'nova', Description: 'Nova Household', CreatedAt: now }
      ],
      { header: ['ID','Name','Code','Description','CreatedAt'] }
    ), GROUPS_SHEET);
    xlsx.writeFile(wb, EXCEL_PATH);
    ensureGroupFile('neo');
    ensureGroupFile('nova');
    console.log('[INIT] Created bills.xlsx with Neo + Nova groups');
    return;
  }
  const wb = xlsx.readFile(EXCEL_PATH);
  let changed = false;
  const ensureSheet = (name, header) => {
    if (!wb.Sheets[name]) {
      wb.Sheets[name] = xlsx.utils.aoa_to_sheet([header]);
      wb.SheetNames.push(name);
      changed = true;
    }
  };
  ensureSheet(LOANS_SHEET,    ['ID','Loan Name','Lender','Principal','Monthly Payment','Terms','Start Date','Due Day','Notes']);
  ensureSheet(LOAN_PMT_SHEET, ['ID','Loan ID','Amount','Payment Date','Notes']);
  ensureSheet(INCOME_SHEET,   ['ID','Description','Category','Amount','Date','Notes']);
  ensureSheet(GROUPS_SHEET,   ['ID','Name','Code','Description','CreatedAt']);
  // Seed Neo and Nova groups if the Groups sheet is empty
  {
    const groups = xlsx.utils.sheet_to_json(wb.Sheets[GROUPS_SHEET], { defval: '' });
    if (!groups.length) {
      const now = new Date().toISOString();
      const seeded = [
        { ID: 1, Name: 'Neo',  Code: 'neo',  Description: 'Neo Household',  CreatedAt: now },
        { ID: 2, Name: 'Nova', Code: 'nova', Description: 'Nova Household', CreatedAt: now }
      ];
      wb.Sheets[GROUPS_SHEET] = xlsx.utils.json_to_sheet(seeded, {
        header: ['ID','Name','Code','Description','CreatedAt']
      });
      changed = true;
      console.log('[INIT] Seeded groups: Neo, Nova');
      // Create their data files
      ensureGroupFile('neo');
      ensureGroupFile('nova');
    }
  }
  if (!wb.Sheets[USERS_SHEET]) {
    const { salt, hash } = hashPassword('admin123');
    wb.Sheets[USERS_SHEET] = xlsx.utils.json_to_sheet(
      [{ ID: 1, Username: 'admin', Salt: salt, Hash: hash, Status: 'Active', GroupCode: 'admin', CreatedAt: new Date().toISOString() }],
      { header: ['ID','Username','Salt','Hash','Status','GroupCode','CreatedAt'] }
    );
    wb.SheetNames.push(USERS_SHEET);
    changed = true;
    console.log('[AUTH] Created default user: admin / admin123');
  } else {
    // Patch existing admin user to have GroupCode if missing
    const users = xlsx.utils.sheet_to_json(wb.Sheets[USERS_SHEET], { defval: '' });
    const adminIdx = users.findIndex(u => u.Username.toLowerCase() === 'admin');
    if (adminIdx !== -1 && !users[adminIdx].GroupCode) {
      users[adminIdx].GroupCode = 'admin';
      wb.Sheets[USERS_SHEET] = xlsx.utils.json_to_sheet(users, {
        header: ['ID','Username','Salt','Hash','Status','GroupCode','CreatedAt']
      });
      changed = true;
    }
  }
  if (changed) {
    xlsx.writeFile(wb, EXCEL_PATH);
    console.log('[INIT] Updated bills.xlsx');
  }
}

// ════════════════════════════════════════
//  DATA HELPERS  (file-aware)
// ════════════════════════════════════════

function readBills(file) {
  file = file || EXCEL_PATH;
  const wb = xlsx.readFile(file);
  return xlsx.utils.sheet_to_json(wb.Sheets[SHEET] || {}, { defval: '' });
}
function writeBills(rows, file) {
  file = file || EXCEL_PATH;
  const wb = xlsx.readFile(file);
  wb.Sheets[SHEET] = xlsx.utils.json_to_sheet(rows, {
    header: ['ID','Bill Name','Category','Amount','Due Date','Status','Payment Date','Notes','Attachment','Recurrence']
  });
  xlsx.writeFile(wb, file);
  console.log(`[SAVE] ${rows.length} bills → ${path.basename(file)}`);
}

function readLoans(file) {
  file = file || EXCEL_PATH;
  const wb = xlsx.readFile(file);
  return xlsx.utils.sheet_to_json(wb.Sheets[LOANS_SHEET] || {}, { defval: '' });
}
function writeLoans(rows, file) {
  file = file || EXCEL_PATH;
  const wb = xlsx.readFile(file);
  wb.Sheets[LOANS_SHEET] = xlsx.utils.json_to_sheet(rows, {
    header: ['ID','Loan Name','Lender','Principal','Monthly Payment','Terms','Start Date','Due Day','Notes']
  });
  xlsx.writeFile(wb, file);
  console.log(`[SAVE] ${rows.length} loans → ${path.basename(file)}`);
}

function readLoanPayments(file) {
  file = file || EXCEL_PATH;
  const wb = xlsx.readFile(file);
  return xlsx.utils.sheet_to_json(wb.Sheets[LOAN_PMT_SHEET] || {}, { defval: '' });
}
function writeLoanPayments(rows, file) {
  file = file || EXCEL_PATH;
  const wb = xlsx.readFile(file);
  wb.Sheets[LOAN_PMT_SHEET] = xlsx.utils.json_to_sheet(rows, {
    header: ['ID','Loan ID','Amount','Payment Date','Notes']
  });
  xlsx.writeFile(wb, file);
  console.log(`[SAVE] ${rows.length} loan payments → ${path.basename(file)}`);
}

function readIncome(file) {
  file = file || EXCEL_PATH;
  const wb = xlsx.readFile(file);
  return xlsx.utils.sheet_to_json(wb.Sheets[INCOME_SHEET] || {}, { defval: '' });
}
function writeIncome(rows, file) {
  file = file || EXCEL_PATH;
  const wb = xlsx.readFile(file);
  wb.Sheets[INCOME_SHEET] = xlsx.utils.json_to_sheet(rows, {
    header: ['ID','Description','Category','Amount','Date','Notes']
  });
  xlsx.writeFile(wb, file);
  console.log(`[SAVE] ${rows.length} income → ${path.basename(file)}`);
}

function nextId(rows) {
  if (!rows.length) return 1;
  return Math.max(...rows.map(r => Number(r.ID) || 0)) + 1;
}

const ALL_GROUPS_ERR = { error: 'Switch to a specific group to add or edit transactions.' };

// ════════════════════════════════════════
//  BILLS API
// ════════════════════════════════════════

app.get('/api/bills', (req, res) => {
  try {
    if (req.dataFile === '__all__') {
      const groups = readGroups();
      let all = readBills(EXCEL_PATH).map(b => ({ ...b, _Group: 'Admin', _GroupCode: 'admin' }));
      for (const g of groups) {
        const f = getGroupFile(g.Code);
        if (fs.existsSync(f))
          readBills(f).forEach(b => all.push({ ...b, _Group: g.Name, _GroupCode: g.Code }));
      }
      return res.json(all);
    }
    res.json(readBills(req.dataFile));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bills', async (req, res) => {
  if (req.dataFile === '__all__') return res.status(400).json(ALL_GROUPS_ERR);
  try {
    await withFile(req.dataFile, () => {
      const rows = readBills(req.dataFile);
      const bill = {
        ID:             nextId(rows),
        'Bill Name':    req.body['Bill Name']    || '',
        Category:       req.body.Category        || '',
        Amount:         req.body.Amount          || 0,
        'Due Date':     req.body['Due Date']     || '',
        Status:         req.body.Status          || 'Unpaid',
        'Payment Date': req.body['Payment Date'] || '',
        Notes:          req.body.Notes           || '',
        Attachment:     '',
        Recurrence:     req.body.Recurrence      || ''
      };
      rows.push(bill);
      writeBills(rows, req.dataFile);
      res.json(bill);
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/bills/:id', async (req, res) => {
  if (req.dataFile === '__all__') return res.status(400).json(ALL_GROUPS_ERR);
  try {
    await withFile(req.dataFile, () => {
      const rows = readBills(req.dataFile);
      const idx  = rows.findIndex(r => String(r.ID) === String(req.params.id));
      if (idx === -1) return res.status(404).json({ error: 'Bill not found' });
      rows[idx] = { ...rows[idx], ...req.body, ID: rows[idx].ID };
      writeBills(rows, req.dataFile);
      res.json(rows[idx]);
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/bills/:id', async (req, res) => {
  if (req.dataFile === '__all__') return res.status(400).json(ALL_GROUPS_ERR);
  try {
    await withFile(req.dataFile, () => {
      const rows = readBills(req.dataFile);
      const bill = rows.find(r => String(r.ID) === String(req.params.id));
      if (bill && bill.Attachment) {
        const fp = path.join(UPLOADS_DIR, bill.Attachment);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      }
      writeBills(rows.filter(r => String(r.ID) !== String(req.params.id)), req.dataFile);
      res.json({ ok: true });
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bills/:id/attachment', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const rows = readBills(req.dataFile);
    const idx  = rows.findIndex(r => String(r.ID) === String(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'Bill not found' });
    const old = rows[idx].Attachment;
    if (old && old !== req.file.filename) {
      const fp = path.join(UPLOADS_DIR, old);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    rows[idx].Attachment = req.file.filename;
    writeBills(rows, req.dataFile);
    res.json({ filename: req.file.filename });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/bills/:id/attachment', (req, res) => {
  try {
    const rows = readBills(req.dataFile);
    const idx  = rows.findIndex(r => String(r.ID) === String(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'Bill not found' });
    const att = rows[idx].Attachment;
    if (att) {
      const fp = path.join(UPLOADS_DIR, att);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      rows[idx].Attachment = '';
      writeBills(rows, req.dataFile);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
//  LOANS API
// ════════════════════════════════════════

app.get('/api/loans', (req, res) => {
  try {
    if (req.dataFile === '__all__') {
      const groups = readGroups();
      let all = readLoans(EXCEL_PATH).map(l => ({ ...l, _Group: 'Admin', _GroupCode: 'admin' }));
      for (const g of groups) {
        const f = getGroupFile(g.Code);
        if (fs.existsSync(f))
          readLoans(f).forEach(l => all.push({ ...l, _Group: g.Name, _GroupCode: g.Code }));
      }
      return res.json(all);
    }
    res.json(readLoans(req.dataFile));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/loans', async (req, res) => {
  if (req.dataFile === '__all__') return res.status(400).json(ALL_GROUPS_ERR);
  try {
    await withFile(req.dataFile, () => {
      const rows = readLoans(req.dataFile);
      const loan = {
        ID:                nextId(rows),
        'Loan Name':       req.body['Loan Name']       || '',
        Lender:            req.body.Lender              || '',
        Principal:         req.body.Principal           || 0,
        'Monthly Payment': req.body['Monthly Payment']  || 0,
        Terms:             req.body.Terms               || '',
        'Start Date':      req.body['Start Date']       || '',
        'Due Day':         req.body['Due Day']           || '',
        Notes:             req.body.Notes               || ''
      };
      rows.push(loan);
      writeLoans(rows, req.dataFile);
      res.json(loan);
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/loans/:id', async (req, res) => {
  if (req.dataFile === '__all__') return res.status(400).json(ALL_GROUPS_ERR);
  try {
    await withFile(req.dataFile, () => {
      const rows = readLoans(req.dataFile);
      const idx  = rows.findIndex(r => String(r.ID) === String(req.params.id));
      if (idx === -1) return res.status(404).json({ error: 'Loan not found' });
      rows[idx] = { ...rows[idx], ...req.body, ID: rows[idx].ID };
      writeLoans(rows, req.dataFile);
      res.json(rows[idx]);
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/loans/:id', async (req, res) => {
  if (req.dataFile === '__all__') return res.status(400).json(ALL_GROUPS_ERR);
  try {
    await withFile(req.dataFile, () => {
      const lns  = readLoans(req.dataFile).filter(r => String(r.ID) !== String(req.params.id));
      const pmts = readLoanPayments(req.dataFile).filter(p => String(p['Loan ID']) !== String(req.params.id));
      writeLoans(lns, req.dataFile);
      writeLoanPayments(pmts, req.dataFile);
      res.json({ ok: true });
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
//  LOAN PAYMENTS API
// ════════════════════════════════════════

app.get('/api/loan-payments', (req, res) => {
  try {
    if (req.dataFile === '__all__') {
      const groups = readGroups();
      let all = readLoanPayments(EXCEL_PATH).map(p => ({ ...p, _GroupCode: 'admin' }));
      for (const g of groups) {
        const f = getGroupFile(g.Code);
        if (fs.existsSync(f))
          readLoanPayments(f).forEach(p => all.push({ ...p, _GroupCode: g.Code }));
      }
      return res.json(all);
    }
    res.json(readLoanPayments(req.dataFile));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/loan-payments', async (req, res) => {
  try {
    await withFile(req.dataFile, () => {
      const rows = readLoanPayments(req.dataFile);
      const pmt  = {
        ID:             nextId(rows),
        'Loan ID':      req.body['Loan ID'],
        Amount:         req.body.Amount          || 0,
        'Payment Date': req.body['Payment Date'] || '',
        Notes:          req.body.Notes           || ''
      };
      rows.push(pmt);
      writeLoanPayments(rows, req.dataFile);
      res.json(pmt);
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/loan-payments/:id', async (req, res) => {
  try {
    await withFile(req.dataFile, () => {
      const rows = readLoanPayments(req.dataFile).filter(r => String(r.ID) !== String(req.params.id));
      writeLoanPayments(rows, req.dataFile);
      res.json({ ok: true });
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
//  INCOME API
// ════════════════════════════════════════

app.get('/api/income', (req, res) => {
  try { res.json(readIncome(req.dataFile)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/income', async (req, res) => {
  try {
    await withFile(req.dataFile, () => {
      const rows  = readIncome(req.dataFile);
      const entry = {
        ID:          nextId(rows),
        Description: req.body.Description || '',
        Category:    req.body.Category    || 'Other',
        Amount:      req.body.Amount      || 0,
        Date:        req.body.Date        || '',
        Notes:       req.body.Notes       || ''
      };
      rows.push(entry);
      writeIncome(rows, req.dataFile);
      res.json(entry);
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/income/:id', async (req, res) => {
  try {
    await withFile(req.dataFile, () => {
      const rows = readIncome(req.dataFile);
      const idx  = rows.findIndex(r => String(r.ID) === String(req.params.id));
      if (idx === -1) return res.status(404).json({ error: 'Entry not found' });
      rows[idx] = { ...rows[idx], ...req.body, ID: rows[idx].ID };
      writeIncome(rows, req.dataFile);
      res.json(rows[idx]);
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/income/:id', async (req, res) => {
  try {
    await withFile(req.dataFile, () => {
      const rows = readIncome(req.dataFile).filter(r => String(r.ID) !== String(req.params.id));
      writeIncome(rows, req.dataFile);
      res.json({ ok: true });
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Start ──────────────────────────────────────────────────────
initFile();
app.listen(PORT, () => {
  console.log('─────────────────────────────────────────');
  console.log('  Cut-off Expense Monitor');
  console.log(`  File : ${EXCEL_PATH}`);
  console.log(`  Open : http://localhost:${PORT}`);
  console.log('─────────────────────────────────────────');
});
