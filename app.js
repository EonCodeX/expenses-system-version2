    // ── Response decryption (AES-256-GCM) ────────────────────────
    const _EK = '7f3a9c2e1d8b054f6a4e7c3b9d2f1e085c4b7a3e9d1f208a6e4c7b3a9d2f108e';
    function _h2b(h) {
      const a = new Uint8Array(h.length / 2);
      for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16);
      return a;
    }
    async function _dec(enc) {
      const parts = enc.split(':');
      const iv  = _h2b(parts[0]);
      const tag = _h2b(parts[1]);
      const ct  = _h2b(parts[2]);
      const buf = new Uint8Array(ct.length + tag.length);
      buf.set(ct); buf.set(tag, ct.length);
      const key = await crypto.subtle.importKey('raw', _h2b(_EK), { name: 'AES-GCM' }, false, ['decrypt']);
      const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, buf);
      return JSON.parse(new TextDecoder().decode(dec));
    }
    // Transparently decrypt all /api responses — no fetch call-sites changed
    const _origFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const res = await _origFetch(...args);
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      if (!url.startsWith('/api/')) return res;
      const origJson = res.json.bind(res);
      res.json = async () => { const d = await origJson(); return d.enc ? _dec(d.enc) : d; };
      return res;
    };

    // ── State ─────────────────────────────────────────────────────
    let bills = [];
    let editId = null;
    let deleteId = null;
    let deleteContext = 'bill';   // 'bill' | 'loan'
    let filterStatus = 'all';
    let filterCutoff = '';
    let dashFilterMonth = '';
    let dashFilterCutoff = '';
    let attBillId = null;
    let sortKey = 'Due Date';
    let sortAsc = true;
    let activePage = 'dashboard';

    // Loans
    let loans = [];
    let loanPayments = [];
    let editLoanId = null;
    let deleteLoanId = null;
    let viewLoanId = null;
    let loanFilterStatus = 'all';

    // ── Boot ──────────────────────────────────────────────────────
    window.addEventListener('DOMContentLoaded', () => {
      const now = new Date();
      document.getElementById('top-date').textContent =
        now.toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      document.getElementById('c-month-label').textContent =
        now.toLocaleDateString('en-PH', { month: 'short', year: 'numeric' }).toUpperCase();

      // Auto-detect current cut-off period from today's date
      const day = now.getDate();
      const currentCutoff = day <= 15 ? '1-15' : '16-31';
      const currentMonth = now.toISOString().slice(0, 7); // YYYY-MM

      // Pre-select filters
      dashFilterCutoff = currentCutoff;
      dashFilterMonth = currentMonth;
      filterCutoff = currentCutoff;

      // Sync dashboard cut-off tabs
      document.querySelectorAll('[data-dashcut]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.dashcut === currentCutoff);
      });

      // Show current cut-off chip in topbar subtitle
      const cutLabel = currentCutoff === '1-15' ? '1st Cut (1–15)' : '2nd Cut (16–31)';
      document.getElementById('page-sub').textContent = `📌 ${cutLabel}`;

      loadBills();
      loadLoans();
      initSession();
    });

    async function loadBills() {
      showEmpty('Loading…', '<span style="display:inline-block;width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin .65s linear infinite;vertical-align:middle"></span>');
      try {
        const res = await fetch('/api/bills');
        bills = await res.json();
        if (bills.error) throw new Error(bills.error);
        render();
      } catch (e) {
        showEmpty('Cannot connect to server', 'Run: npm start  then open http://localhost:3000');
      }
    }

    // ── Navigation ────────────────────────────────────────────────
    document.querySelectorAll('.nav-item[data-page], .nav-sub-item[data-page], .mn-item[data-page]').forEach(btn => {
      btn.addEventListener('click', () => switchPage(btn.dataset.page));
    });

    function switchPage(page) {
      activePage = page;
      // Sync both sidebar nav and mobile bottom nav
      document.querySelectorAll('.nav-item[data-page], .nav-sub-item[data-page], .mn-item[data-page]').forEach(b =>
        b.classList.toggle('active', b.dataset.page === page));
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.getElementById('page-' + page).classList.add('active');
      const titles = { dashboard: 'Dashboard', bills: 'Bills Management', loans: 'Loan Tracker', users: 'User Management', groups: 'Group Management' };
      document.getElementById('page-title').textContent = titles[page] || page;
      if (page === 'bills') {
        const glabel = currentGroupName ? ` · 🏠 ${currentGroupName}` : '';
        document.getElementById('page-sub').textContent = `${bills.length} bills${glabel}`;
      } else if (page === 'loans') {
        const glabel = currentGroupName ? ` · 🏠 ${currentGroupName}` : '';
        document.getElementById('page-sub').textContent = `${loans.length} loans${glabel}`;
      } else if (page === 'users') {
        const pending = allUsers.filter(u => u.Status === 'Pending').length;
        document.getElementById('page-sub').textContent = pending > 0 ? `${pending} pending approval` : `${allUsers.length} users`;
      } else if (page === 'groups') {
        document.getElementById('page-sub').textContent = `${allGroups.length} groups`;
      } else {
        const cutLabel = dashFilterCutoff === '1-15' ? '1st Cut (1–15)' : dashFilterCutoff === '16-31' ? '2nd Cut (16–31)' : '';
        document.getElementById('page-sub').textContent = cutLabel ? `📌 ${cutLabel}` : '';
      }
    }

    // ── Helpers ───────────────────────────────────────────────────
    function matchesCutoff(bill, cutoff) {
      if (!cutoff) return true;
      if (!bill['Due Date']) return false;
      const day = new Date(bill['Due Date']).getDate();
      return cutoff === '1-15' ? day <= 15 : day >= 16;
    }

    // ── Computed ──────────────────────────────────────────────────
    function effectiveStatus(b) {
      if (b.Status === 'Paid') return 'Paid';
      const due = b['Due Date'] ? new Date(b['Due Date']) : null;
      if (due) due.setHours(0, 0, 0, 0);
      if (due && due < today()) return 'Overdue';
      return 'Unpaid';
    }
    function today() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
    function daysUntil(dateStr) {
      if (!dateStr) return null;
      const d = new Date(dateStr); d.setHours(0, 0, 0, 0);
      return Math.ceil((d - today()) / 86400000);
    }

    // ── Render all ────────────────────────────────────────────────
    function render() {
      refreshMonthFilter();
      // Re-sync dropdowns with current filter state after options are rebuilt
      document.getElementById('dash-month').value = dashFilterMonth;
      document.getElementById('filter-cutoff').value = filterCutoff;
      updateDashboard();
      renderTable();
      updateNotifBadge();
      if (activePage !== 'bills') {
        const cutLabel = dashFilterCutoff === '1-15' ? '1st Cut (1–15)' : dashFilterCutoff === '16-31' ? '2nd Cut (16–31)' : '';
        document.getElementById('page-sub').textContent = cutLabel ? `📌 ${cutLabel}` : '';
      } else {
        const gl = currentGroupName ? ` · 🏠 ${currentGroupName}` : '';
        document.getElementById('page-sub').textContent = `${bills.length} bills${gl}`;
      }
    }

    // ── Dashboard ─────────────────────────────────────────────────
    function updateDashboard() {
      // Apply dashboard period filters
      let src = bills;
      if (dashFilterMonth) {
        src = src.filter(b => b['Due Date'] && b['Due Date'].slice(0, 7) === dashFilterMonth);
      }
      if (dashFilterCutoff) {
        src = src.filter(b => matchesCutoff(b, dashFilterCutoff));
      }
      // Update filter label
      const lbl = document.getElementById('dash-filter-label');
      const parts = [];
      if (dashFilterMonth) {
        const [y, mo] = dashFilterMonth.split('-');
        parts.push(new Date(y, mo - 1, 1).toLocaleDateString('en-PH', { month: 'long', year: 'numeric' }));
      }
      if (dashFilterCutoff) parts.push(dashFilterCutoff === '1-15' ? '1st Cut (1–15)' : '2nd Cut (16–31)');
      lbl.textContent = parts.length ? '📌 ' + parts.join(' · ') : '';

      const sum = arr => arr.reduce((s, b) => s + (parseFloat(b.Amount) || 0), 0);
      const paid = src.filter(b => effectiveStatus(b) === 'Paid');
      const unpaid = src.filter(b => effectiveStatus(b) === 'Unpaid');
      const overdue = src.filter(b => effectiveStatus(b) === 'Overdue');
      const remaining = [...unpaid, ...overdue];
      const now = new Date();
      const month = src.filter(b => {
        if (!b['Due Date']) return false;
        const d = new Date(b['Due Date']);
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      });
      const week = src.filter(b => {
        const d = daysUntil(b['Due Date']);
        return effectiveStatus(b) !== 'Paid' && d !== null && d >= 0 && d <= 7;
      });
      const todayBills = src.filter(b =>
        effectiveStatus(b) !== 'Paid' && daysUntil(b['Due Date']) === 0);

      const totalAmt = sum(src);
      const paidAmt = sum(paid);
      const pct = totalAmt > 0 ? Math.round((paidAmt / totalAmt) * 100) : 0;

      // Hero
      setText('c-total', src.length);
      setText('c-total-amt', fmt(totalAmt));
      setText('c-paid', paid.length);
      setText('c-paid-amt', fmt(paidAmt));
      setText('c-paid-pct', pct + '%');
      setText('c-remain', remaining.length);
      setText('c-remain-amt', fmt(sum(remaining)));
      document.getElementById('c-paid-bar').style.width = pct + '%';
      document.getElementById('ps-bar').style.width = pct + '%';
      setText('ps-pct', pct + '%');
      setText('ps-text', fmt(paidAmt) + ' paid of ' + fmt(totalAmt));

      // Stats
      setText('c-overdue', overdue.length);
      setText('c-overdue-amt', fmt(sum(overdue)));
      setText('c-week', week.length);
      setText('c-week-amt', fmt(sum(week)));
      setText('c-today', todayBills.length);
      setText('c-today-amt', fmt(sum(todayBills)));
      setText('c-month', month.length);
      setText('c-month-amt', fmt(sum(month)));

      const show = (id, v) => document.getElementById(id).style.display = v ? '' : 'none';
      show('c-overdue-badge', overdue.length > 0);
      show('c-week-badge', week.length > 0);
      show('c-today-badge', todayBills.length > 0);
      document.querySelector('.sc-overdue .sc-icon').classList.toggle('sc-pulse', overdue.length > 0);

      // Nav badges — always based on all bills regardless of filter
      const allOverdue = bills.filter(b => effectiveStatus(b) === 'Overdue');
      const nb = document.getElementById('nav-overdue-badge');
      const mnb = document.getElementById('mn-overdue-badge');
      if (allOverdue.length > 0) {
        nb.textContent = allOverdue.length; nb.classList.add('show');
        mnb.textContent = allOverdue.length; mnb.classList.add('show');
      } else {
        nb.classList.remove('show');
        mnb.classList.remove('show');
      }

      // Alert strips
      const odEl = document.getElementById('alert-overdue');
      if (overdue.length > 0) {
        odEl.classList.add('visible');
        document.getElementById('alert-overdue-list').innerHTML =
          overdue.map(b => {
            const d = Math.abs(daysUntil(b['Due Date']));
            return `<span class="alert-pill">${esc(b['Bill Name'])} · ${d}d ago · ${fmt(b.Amount)}</span>`;
          }).join('');
      } else odEl.classList.remove('visible');

      const soon3 = src.filter(b => {
        const d = daysUntil(b['Due Date']);
        return effectiveStatus(b) !== 'Paid' && d !== null && d >= 0 && d <= 3;
      });
      const snEl = document.getElementById('alert-soon');
      if (soon3.length > 0) {
        snEl.classList.add('visible');
        document.getElementById('alert-soon-list').innerHTML =
          soon3.map(b => {
            const d = daysUntil(b['Due Date']);
            return `<span class="alert-pill">${esc(b['Bill Name'])} · ${d === 0 ? 'Today!' : d + 'd left'} · ${fmt(b.Amount)}</span>`;
          }).join('');
      } else snEl.classList.remove('visible');

      // Upcoming bills list (next 8, unpaid/overdue, sorted by due date)
      const upcoming = src
        .filter(b => effectiveStatus(b) !== 'Paid' && b['Due Date'])
        .sort((a, b) => new Date(a['Due Date']) - new Date(b['Due Date']))
        .slice(0, 8);
      const upEl = document.getElementById('upcoming-list');
      if (upcoming.length) {
        upEl.innerHTML = upcoming.map(b => {
          const d = daysUntil(b['Due Date']);
          const st = effectiveStatus(b);
          const dotClass = st === 'Overdue' ? 'dot-overdue' : d <= 3 ? 'dot-soon' : 'dot-upcoming';
          const badgeClass = st === 'Overdue' ? 'mb-overdue' : d === 0 ? 'mb-today' : d <= 3 ? 'mb-soon' : 'mb-upcoming';
          const badgeText = st === 'Overdue' ? Math.abs(d) + 'd ago' : d === 0 ? 'Today!' : d + 'd left';
          return `<div class="mini-row">
          <div class="mini-dot ${dotClass}"></div>
          <div class="mini-info">
            <div class="mini-name">${esc(b['Bill Name'])}</div>
            <div class="mini-meta">${esc(b.Category)} · ${fmtDate(b['Due Date'])}</div>
          </div>
          <span class="mini-amount">${fmt(b.Amount)}</span>
          <span class="mini-badge ${badgeClass}">${badgeText}</span>
        </div>`;
        }).join('');
      } else {
        upEl.innerHTML = '<div class="mini-empty">🎉 All bills are paid!</div>';
      }

      // Recent payments (last 8 paid, sorted by payment date desc)
      const recent = src
        .filter(b => b.Status === 'Paid' && b['Payment Date'])
        .sort((a, b) => new Date(b['Payment Date']) - new Date(a['Payment Date']))
        .slice(0, 8);
      const reEl = document.getElementById('recent-list');
      if (recent.length) {
        reEl.innerHTML = recent.map(b =>
          `<div class="mini-row">
          <div class="mini-dot dot-paid"></div>
          <div class="mini-info">
            <div class="mini-name">${esc(b['Bill Name'])}</div>
            <div class="mini-meta">${esc(b.Category)} · Paid ${fmtDate(b['Payment Date'])}</div>
          </div>
          <span class="mini-amount">${fmt(b.Amount)}</span>
          <span class="mini-badge mb-paid">Paid</span>
        </div>`
        ).join('');
      } else {
        reEl.innerHTML = '<div class="mini-empty">No payments recorded yet</div>';
      }
    }

    // ── Month filter ──────────────────────────────────────────────
    function refreshMonthFilter() {
      const months = [...new Set(
        bills.filter(b => b['Due Date']).map(b => b['Due Date'].slice(0, 7))
      )].sort();
      const makeOpts = (prefix) => months.map(m => {
        const [y, mo] = m.split('-');
        const label = new Date(y, mo - 1, 1).toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
        return `<option value="${m}">${label}</option>`;
      }).join('');

      // Bills page month filter
      const sel = document.getElementById('filter-month');
      const cur = sel.value;
      sel.innerHTML = '<option value="">📅 All Months</option>' + makeOpts();
      sel.value = cur;

      // Dashboard month filter
      const dashSel = document.getElementById('dash-month');
      const dashCur = dashSel.value;
      dashSel.innerHTML = '<option value="">All Months</option>' + makeOpts();
      dashSel.value = dashCur;
    }

    // ── Table ─────────────────────────────────────────────────────
    function renderTable() {
      const search = document.getElementById('filter-search').value.toLowerCase();
      const catFilter = document.getElementById('filter-category').value;
      const monthFilter = document.getElementById('filter-month').value;
      const cutoffFilter = document.getElementById('filter-cutoff').value;

      let filtered = bills.filter(b => {
        const st = effectiveStatus(b);
        if (filterStatus !== 'all' && st !== filterStatus) return false;
        if (catFilter && b.Category !== catFilter) return false;
        if (monthFilter && (!b['Due Date'] || b['Due Date'].slice(0, 7) !== monthFilter)) return false;
        if (cutoffFilter && !matchesCutoff(b, cutoffFilter)) return false;
        if (search && !b['Bill Name'].toLowerCase().includes(search)) return false;
        return true;
      });

      filtered.sort((a, b) => {
        let va = a[sortKey], vb = b[sortKey];
        if (sortKey === 'Amount') { va = parseFloat(va) || 0; vb = parseFloat(vb) || 0; }
        else if (sortKey === 'Due Date' || sortKey === 'Payment Date') {
          va = va ? new Date(va).getTime() : 0;
          vb = vb ? new Date(vb).getTime() : 0;
        } else { va = String(va || '').toLowerCase(); vb = String(vb || '').toLowerCase(); }
        return sortAsc ? (va < vb ? -1 : va > vb ? 1 : 0) : (va > vb ? -1 : va < vb ? 1 : 0);
      });

      const table = document.getElementById('bills-table');
      const emEl = document.getElementById('empty-msg');
      document.getElementById('row-count').textContent =
        filtered.length === bills.length ? `${bills.length} bills` : `${filtered.length} of ${bills.length}`;

      if (!filtered.length) {
        table.style.display = 'none'; emEl.style.display = '';
        showEmpty(!bills.length ? 'No bills yet' : 'No results', !bills.length ? 'Click "+ Add Bill" to start' : 'Adjust your filters');
        return;
      }
      emEl.style.display = 'none'; table.style.display = '';

      // Show/hide the Group column header based on whether data has _Group
      const hasGroup = filtered.length > 0 && filtered[0]._Group !== undefined;
      document.querySelectorAll('.th-group-col').forEach(th => th.style.display = hasGroup ? '' : 'none');
      const isAllGroupsView = hasGroup;

      document.getElementById('bills-body').innerHTML = filtered.map(b => {
        const st = effectiveStatus(b);
        const days = daysUntil(b['Due Date']);
        const rowC = st === 'Overdue' ? 'row-overdue' : st === 'Paid' ? 'row-paid'
          : (days !== null && days <= 7) ? 'row-due-soon' : '';
        const stC = st === 'Paid' ? 'st-paid' : st === 'Overdue' ? 'st-overdue' : 'st-unpaid';

        let dtag = '';
        if (st !== 'Paid' && days !== null) {
          if (days < 0) dtag = `<div><span class="date-tag dt-overdue">${Math.abs(days)}d overdue</span></div>`;
          else if (days === 0) dtag = `<div><span class="date-tag dt-today">Due Today!</span></div>`;
          else if (days <= 3) dtag = `<div><span class="date-tag dt-soon">${days}d left</span></div>`;
          else if (days <= 7) dtag = `<div><span class="date-tag dt-upcoming">${days}d left</span></div>`;
        }

        const payBtn = st !== 'Paid'
          ? `<button class="btn-ic bi-pay"  title="Mark Paid" onclick="markPaid(${b.ID})">✓</button>` : '';

        const attFile = b.Attachment;
        const proofCell = attFile
          ? `<div class="actions">
             <button class="btn-ic bi-att-view" title="View Proof" onclick="viewAttachment(${b.ID},'${esc(attFile)}')">🖼️</button>
             <button class="btn-ic bi-att" title="Replace Proof" onclick="triggerUpload(${b.ID})">📎</button>
           </div>`
          : `<button class="btn-ic bi-att" title="Upload Proof" onclick="triggerUpload(${b.ID})">📎</button>`;

        const recurTag = b.Recurrence
          ? `<span title="Recurring: ${b.Recurrence}" style="margin-left:4px;font-size:11px;background:#e0e7ff;color:#4f46e5;border-radius:5px;padding:1px 5px;font-weight:700">🔄 ${b.Recurrence}</span>`
          : '';
        const groupCell = isAllGroupsView
          ? `<td><span class="cat-badge" style="background:#ede9fe;color:#6d28d9">🏠 ${esc(b._Group || '—')}</span></td>`
          : '';
        const actionBtns = isAllGroupsView
          ? `<span style="font-size:11px;color:var(--muted)">Switch group to edit</span>`
          : `${payBtn}
             <button class="btn-ic bi-edit" title="Edit"   onclick="openEdit(${b.ID})">✏️</button>
             <button class="btn-ic bi-del"  title="Delete" onclick="askDelete(${b.ID},'${esc(b['Bill Name'])}')">🗑</button>`;
        return `<tr class="${rowC}">
        <td><div class="bill-name">${esc(b['Bill Name'])}${recurTag}</div><div class="bill-id">#${b.ID}</div></td>
        ${groupCell}
        <td><span class="cat-badge">${esc(b.Category)}</span></td>
        <td><span class="amount">${fmt(b.Amount)}</span></td>
        <td class="date-cell"><div class="date-main">${fmtDate(b['Due Date'])}</div>${dtag}</td>
        <td><span class="st-badge ${stC}">${st}</span></td>
        <td>${b['Payment Date'] ? `<span class="date-main">${fmtDate(b['Payment Date'])}</span>` : `<span class="muted-cell">—</span>`}</td>
        <td><span class="muted-cell">${esc(b.Notes) || '—'}</span></td>
        <td>${proofCell}</td>
        <td><div class="actions">${actionBtns}</div></td>
      </tr>`;
      }).join('');
    }

    function showEmpty(h, p) {
      const el = document.getElementById('empty-msg');
      el.innerHTML = `<div class="ei">📄</div><h3>${h}</h3><p>${p}</p>`;
      el.style.display = '';
    }

    function sortBy(k) {
      sortKey === k ? (sortAsc = !sortAsc) : (sortKey = k, sortAsc = true);
      renderTable();
    }

    // Status filter tabs — scoped to [data-filter] only
    document.querySelectorAll('.tab[data-filter]').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.tab[data-filter]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        filterStatus = btn.dataset.filter;
        renderTable();
      };
    });
    document.getElementById('filter-month').addEventListener('change', renderTable);
    document.getElementById('filter-cutoff').addEventListener('change', renderTable);
    document.getElementById('filter-category').addEventListener('change', renderTable);
    document.getElementById('filter-search').addEventListener('input', renderTable);

    // Dashboard period filter
    document.getElementById('dash-month').addEventListener('change', () => {
      dashFilterMonth = document.getElementById('dash-month').value;
      updateDashboard();
    });
    document.querySelectorAll('[data-dashcut]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-dashcut]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        dashFilterCutoff = btn.dataset.dashcut;
        updateDashboard();
        const cutLabel = dashFilterCutoff === '1-15' ? '1st Cut (1–15)' : dashFilterCutoff === '16-31' ? '2nd Cut (16–31)' : '';
        document.getElementById('page-sub').textContent = cutLabel ? `📌 ${cutLabel}` : '';
      });
    });

    // ── Mark Paid ─────────────────────────────────────────────────
    function nextRecurringDate(dueDateStr, recurrence) {
      const d = new Date(dueDateStr);
      switch (recurrence) {
        case 'weekly': d.setDate(d.getDate() + 7); break;
        case 'monthly': d.setMonth(d.getMonth() + 1); break;
        case 'bimonthly': d.setMonth(d.getMonth() + 2); break;
        case 'yearly': d.setFullYear(d.getFullYear() + 1); break;
      }
      return d.toISOString().slice(0, 10);
    }

    async function markPaid(id) {
      const t = new Date().toISOString().slice(0, 10);
      try {
        const res = await fetch('/api/bills/' + id, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ Status: 'Paid', 'Payment Date': t })
        });
        const u = await res.json();
        if (u.error) throw new Error(u.error);
        const i = bills.findIndex(b => b.ID == id);
        if (i !== -1) bills[i] = u;

        // Auto-create next bill for recurring entries
        if (u.Recurrence && u['Due Date']) {
          const nextDue = nextRecurringDate(u['Due Date'], u.Recurrence);
          const payload = {
            'Bill Name': u['Bill Name'],
            Category: u.Category,
            Amount: u.Amount,
            'Due Date': nextDue,
            Status: 'Unpaid',
            'Payment Date': '',
            Notes: u.Notes,
            Recurrence: u.Recurrence
          };
          const r2 = await fetch('/api/bills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          const nb = await r2.json();
          if (!nb.error) bills.push(nb);
          render();
          toast('✅ Paid! Next due ' + fmtDate(nextDue) + ' created 🔄');
        } else {
          render();
          toast('✅ Marked as Paid!');
        }
      } catch (e) { toast('❌ ' + e.message); }
    }

    // ── Add / Edit modal ──────────────────────────────────────────
    document.getElementById('btn-add-bill').onclick = () => {
      editId = null;
      setText('modal-title', 'Add New Bill');
      document.getElementById('btn-modal-save').textContent = 'Add Bill';
      clearForm();
      document.getElementById('modal-overlay').classList.add('open');
      document.getElementById('f-name').focus();
    };

    function openEdit(id) {
      const b = bills.find(b => b.ID == id); if (!b) return;
      editId = id;
      setText('modal-title', 'Edit Bill');
      document.getElementById('btn-modal-save').textContent = 'Save Changes';
      document.getElementById('f-name').value = b['Bill Name'] || '';
      document.getElementById('f-category').value = b.Category || 'Others';
      document.getElementById('f-amount').value = b.Amount || '';
      document.getElementById('f-due').value = b['Due Date'] || '';
      document.getElementById('f-status').value = b.Status || 'Unpaid';
      document.getElementById('f-paydate').value = b['Payment Date'] || '';
      document.getElementById('f-notes').value = b.Notes || '';
      document.getElementById('f-recurrence').value = b.Recurrence || '';
      document.getElementById('modal-overlay').classList.add('open');
    }

    document.getElementById('btn-modal-save').onclick = async () => {
      const name = document.getElementById('f-name').value.trim();
      const due = document.getElementById('f-due').value;
      if (!name) { toast('⚠️ Bill Name is required'); return; }
      if (!due) { toast('⚠️ Due Date is required'); return; }
      const payload = {
        'Bill Name': name,
        Category: document.getElementById('f-category').value,
        Amount: parseFloat(document.getElementById('f-amount').value) || 0,
        'Due Date': due,
        Status: document.getElementById('f-status').value,
        'Payment Date': document.getElementById('f-paydate').value,
        Notes: document.getElementById('f-notes').value.trim(),
        Recurrence: document.getElementById('f-recurrence').value
      };
      const btn = document.getElementById('btn-modal-save');
      btnLoad(btn, true, 'Saving…');
      try {
        if (editId === null) {
          const r = await fetch('/api/bills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          const nb = await r.json(); if (nb.error) throw new Error(nb.error);
          bills.push(nb); toast('🎉 Bill added!');
        } else {
          const r = await fetch('/api/bills/' + editId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          const u = await r.json(); if (u.error) throw new Error(u.error);
          const i = bills.findIndex(b => b.ID == editId); if (i !== -1) bills[i] = u;
          toast('✏️ Bill updated!');
        }
        document.getElementById('modal-overlay').classList.remove('open');
        render();
      } catch (e) { toast('❌ ' + e.message); }
      finally { btnLoad(btn, false); }
    };

    document.getElementById('btn-modal-cancel').onclick = () =>
      document.getElementById('modal-overlay').classList.remove('open');
    document.getElementById('modal-overlay').addEventListener('click', e => {
      if (e.target.id === 'modal-overlay') document.getElementById('modal-overlay').classList.remove('open');
    });

    // ── Delete ────────────────────────────────────────────────────
    function askDelete(id, name) {
      deleteId = id;
      deleteContext = 'bill';
      document.getElementById('confirm-msg').textContent = `"${name}" will be permanently deleted.`;
      document.getElementById('confirm-overlay').classList.add('open');
    }
    document.getElementById('btn-yes').onclick = async () => {
      const btn = document.getElementById('btn-yes');
      document.getElementById('confirm-overlay').classList.remove('open');
      btnLoad(btn, true, 'Deleting…');
      try {
        if (deleteContext === 'loan') {
          await fetch('/api/loans/' + deleteLoanId, { method: 'DELETE' });
          loans = loans.filter(l => l.ID != deleteLoanId);
          loanPayments = loanPayments.filter(p => String(p['Loan ID']) !== String(deleteLoanId));
          renderLoans();
          toast('🗑️ Loan deleted.');
        } else {
          await fetch('/api/bills/' + deleteId, { method: 'DELETE' });
          bills = bills.filter(b => b.ID != deleteId);
          render();
          toast('🗑️ Deleted.');
        }
      } catch (e) { toast('❌ ' + e.message); }
      finally { btnLoad(btn, false); }
    };
    document.getElementById('btn-no').onclick = () =>
      document.getElementById('confirm-overlay').classList.remove('open');

    // ── Attachments ───────────────────────────────────────────────
    function triggerUpload(id) {
      attBillId = id;
      const inp = document.getElementById('att-file-input');
      inp.value = '';
      inp.click();
    }

    document.getElementById('att-file-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file || !attBillId) return;
      const fd = new FormData();
      fd.append('file', file);
      try {
        const res = await fetch('/api/bills/' + attBillId + '/attachment', { method: 'POST', body: fd });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const i = bills.findIndex(b => b.ID == attBillId);
        if (i !== -1) bills[i].Attachment = data.filename;
        render();
        toast('📎 Proof uploaded!');
      } catch (err) { toast('❌ ' + err.message); }
    });

    function viewAttachment(id, filename) {
      attBillId = id;
      const url = '/uploads/' + filename;
      const isPDF = filename.toLowerCase().endsWith('.pdf');
      const lb = document.getElementById('lightbox-overlay');
      const body = document.getElementById('lb-body');
      const dlBtn = document.getElementById('lb-download');

      document.getElementById('lb-title').textContent = '📎 ' + filename;
      dlBtn.href = url;
      dlBtn.download = filename;

      if (isPDF) {
        body.className = 'lb-pdf-wrap';
        body.innerHTML = `<a class="lb-pdf-link" href="${url}" target="_blank">📄 Open PDF in new tab</a>`;
      } else {
        body.className = 'lb-image-wrap';
        body.innerHTML = `<img id="lb-img" src="${url}" alt="Payment proof"
        onerror="this.parentNode.innerHTML='<p style=color:rgba(255,255,255,.5);font-size:14px>⚠️ Cannot load image</p>'">`;
        // Toggle zoom on click
        body.onclick = () => body.classList.toggle('zoomed');
      }
      lb.classList.add('open');
    }

    function closeLightbox() {
      document.getElementById('lightbox-overlay').classList.remove('open');
      document.getElementById('lb-body').innerHTML = '';
      document.getElementById('lb-body').className = '';
    }
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && document.getElementById('lightbox-overlay').classList.contains('open')) closeLightbox();
    });

    document.getElementById('lb-close').addEventListener('click', closeLightbox);

    // Close on dark backdrop click (not on toolbar or image)
    document.getElementById('lightbox-overlay').addEventListener('click', e => {
      if (e.target.id === 'lightbox-overlay') closeLightbox();
    });

    document.getElementById('lb-remove').addEventListener('click', async () => {
      if (!attBillId) return;
      if (!confirm('Remove this proof image?')) return;
      try {
        await fetch('/api/bills/' + attBillId + '/attachment', { method: 'DELETE' });
        const i = bills.findIndex(b => b.ID == attBillId);
        if (i !== -1) bills[i].Attachment = '';
        closeLightbox();
        render();
        toast('🗑️ Proof removed.');
      } catch (err) { toast('❌ ' + err.message); }
    });

    // ── Helpers ───────────────────────────────────────────────────
    function clearForm() {
      ['f-name', 'f-amount', 'f-due', 'f-paydate', 'f-notes'].forEach(id => document.getElementById(id).value = '');
      document.getElementById('f-category').value = 'Utilities';
      document.getElementById('f-status').value = 'Unpaid';
      document.getElementById('f-recurrence').value = '';
    }
    function fmt(v) {
      return '₱' + (parseFloat(v) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function fmtDate(v) {
      if (!v) return '—';
      const d = new Date(v); if (isNaN(d)) return v;
      return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
    }
    function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
    function esc(s) {
      return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    let toastTimer;
    function toast(msg) {
      const el = document.getElementById('toast');
      el.textContent = msg; el.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
    }
    function btnLoad(btn, loading, loadingText) {
      if (loading) {
        btn.dataset.origText = btn.innerHTML;
        btn.innerHTML = loadingText || 'Saving…';
        btn.classList.add('btn-spin');
        btn.disabled = true;
      } else {
        if (btn.dataset.origText) btn.innerHTML = btn.dataset.origText;
        btn.classList.remove('btn-spin');
        btn.disabled = false;
      }
    }

    // ════════════════════════════════════════
    //  LOANS
    // ════════════════════════════════════════

    async function loadLoans() {
      try {
        const [lr, pr] = await Promise.all([
          fetch('/api/loans').then(r => r.json()),
          fetch('/api/loan-payments').then(r => r.json())
        ]);
        if (lr.error) throw new Error(lr.error);
        if (pr.error) throw new Error(pr.error);
        loans = lr; loanPayments = pr;
        renderLoans();
      } catch (e) { /* silent — server may not have loans yet */ }
    }

    // ── Loan computed ─────────────────────────────────────────────
    function loanPmts(id) {
      return loanPayments.filter(p => String(p['Loan ID']) === String(id));
    }
    function loanTotalPaid(id) {
      return loanPmts(id).reduce((s, p) => s + (parseFloat(p.Amount) || 0), 0);
    }
    function dayOrdinal(n) {
      n = parseInt(n); if (!n) return '';
      const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
      return n + (s[(v - 20) % 10] || s[v] || s[0]);
    }
    function effectiveLoanStatus(loan) {
      const paid = loanTotalPaid(loan.ID);
      const principal = parseFloat(loan.Principal) || 0;
      if (principal > 0 && paid >= principal) return 'Paid Off';
      const dueDay = parseInt(loan['Due Day']) || 0;
      if (dueDay > 0) {
        const now = new Date();
        const due = new Date(now.getFullYear(), now.getMonth(), dueDay);
        due.setHours(0, 0, 0, 0);
        const td = new Date(); td.setHours(0, 0, 0, 0);
        if (td > due) {
          const mo = now.toISOString().slice(0, 7);
          const paidMo = loanPayments.some(p =>
            String(p['Loan ID']) === String(loan.ID) &&
            p['Payment Date'] && p['Payment Date'].slice(0, 7) === mo
          );
          if (!paidMo) return 'Overdue';
        }
      }
      return 'Active';
    }

    // ── Loan KPIs ─────────────────────────────────────────────────
    function updateLoanKPIs() {
      const totalP = loans.reduce((s, l) => s + (parseFloat(l.Principal) || 0), 0);
      const totalPaid = loans.reduce((s, l) => s + loanTotalPaid(l.ID), 0);
      const outstanding = Math.max(0, totalP - totalPaid);
      const overdueN = loans.filter(l => effectiveLoanStatus(l) === 'Overdue').length;
      const pct = totalP > 0 ? Math.min(100, Math.round((totalPaid / totalP) * 100)) : 0;
      setText('l-total-amt', fmt(totalP));
      setText('l-total-count', loans.length);
      setText('l-paid-amt', fmt(totalPaid));
      setText('l-outstanding-amt', fmt(outstanding));
      setText('l-overdue-count', overdueN);
      setText('l-progress-pct', pct + '%');
      const bar = document.getElementById('l-progress-bar');
      if (bar) bar.style.width = pct + '%';
    }

    // ── Render loan table ─────────────────────────────────────────
    function renderLoans() {
      updateLoanKPIs();
      const search = (document.getElementById('loan-search').value || '').toLowerCase();
      const filtered = loans.filter(l => {
        const st = effectiveLoanStatus(l);
        if (loanFilterStatus !== 'all' && st !== loanFilterStatus) return false;
        if (search && !String(l['Loan Name'] || '').toLowerCase().includes(search) &&
          !String(l.Lender || '').toLowerCase().includes(search)) return false;
        return true;
      });
      const table = document.getElementById('loans-table');
      const emEl = document.getElementById('loans-empty');
      document.getElementById('loan-row-count').textContent =
        filtered.length === loans.length ? `${loans.length} loans` : `${filtered.length} of ${loans.length}`;
      if (!filtered.length) {
        table.style.display = 'none'; emEl.style.display = '';
        emEl.innerHTML = `<div class="ei">${loans.length ? '🔍' : '💳'}</div>
        <h3>${loans.length ? 'No results' : 'No loans yet'}</h3>
        <p>${loans.length ? 'Adjust your filters' : 'Click "＋ Add Loan" to start'}</p>`;
        return;
      }
      emEl.style.display = 'none'; table.style.display = '';
      const hasLoanGroup = filtered.length > 0 && filtered[0]._Group !== undefined;
      document.querySelectorAll('.th-group-col').forEach(th => th.style.display = hasLoanGroup ? '' : 'none');
      const isAllGroupsLoan = hasLoanGroup;
      document.getElementById('loans-body').innerHTML = filtered.map(l => {
        const st = effectiveLoanStatus(l);
        const principal = parseFloat(l.Principal) || 0;
        const paid = loanTotalPaid(l.ID);
        const remaining = Math.max(0, principal - paid);
        const pct = principal > 0 ? Math.min(100, Math.round((paid / principal) * 100)) : 0;
        const monthly = parseFloat(l['Monthly Payment']) || 0;
        const rowCls = st === 'Overdue' ? 'row-overdue' : st === 'Paid Off' ? 'row-paid' : '';
        const stCls = st === 'Paid Off' ? 'st-paid' : st === 'Overdue' ? 'st-overdue' : 'st-unpaid';
        const barClr = pct >= 100 ? 'var(--success)' : pct >= 50 ? 'var(--primary)' : 'var(--warning)';
        const lGroupCell = isAllGroupsLoan
          ? `<td><span class="cat-badge" style="background:#ede9fe;color:#6d28d9">🏠 ${esc(l._Group || '—')}</span></td>`
          : '';
        return `<tr class="${rowCls}">
        <td>
          <div class="bill-name">${esc(l['Loan Name'])}</div>
          <div class="bill-id">#${l.ID}${l['Start Date'] ? ' · ' + fmtDate(l['Start Date']) : ''}</div>
        </td>
        ${lGroupCell}
        <td><span class="muted-cell">${esc(l.Lender || '—')}</span></td>
        <td>
          <span class="amount">${fmt(principal)}</span>
          ${l.Terms ? '<div class="bill-id">' + esc(l.Terms) + ' months</div>' : ''}
        </td>
        <td>
          ${monthly ? '<span class="amount" style="font-size:13px">' + fmt(monthly) + '</span>' : '<span class="muted-cell">—</span>'}
          ${l['Due Day'] ? '<div class="bill-id">due ' + dayOrdinal(l['Due Day']) + '</div>' : ''}
        </td>
        <td style="min-width:140px">
          <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px">
            <span style="font-weight:700;color:var(--success)">${fmt(paid)}</span>
            <span style="color:var(--muted)">${pct}%</span>
          </div>
          <div style="background:var(--bg);border-radius:99px;height:6px;overflow:hidden">
            <div style="height:100%;border-radius:99px;background:${barClr};width:${pct}%;transition:width .5s"></div>
          </div>
        </td>
        <td><span class="amount" style="font-size:13px;color:${remaining > 0 ? 'var(--warning)' : 'var(--success)'}">${fmt(remaining)}</span></td>
        <td><span class="st-badge ${stCls}">${st}</span></td>
        <td><div class="actions">
          ${isAllGroupsLoan
            ? `<span style="font-size:11px;color:var(--muted)">Switch group to edit</span>`
            : `<button class="btn-ic" style="background:#e0f2fe;color:#0369a1;width:auto;padding:0 10px;font-size:11px;font-weight:700;border-radius:7px" onclick="openLoanPayments(${l.ID})" title="Payments">💳 Pay</button>
               <button class="btn-ic bi-edit" onclick="openEditLoan(${l.ID})" title="Edit">✏️</button>
               <button class="btn-ic bi-del"  onclick="askDeleteLoan(${l.ID},'${esc(l['Loan Name'])}')" title="Delete">🗑</button>`}
        </div></td>
      </tr>`;
      }).join('');
    }

    // ── Add / Edit loan ───────────────────────────────────────────
    document.getElementById('btn-add-loan').onclick = () => {
      editLoanId = null;
      setText('loan-modal-title', 'Add New Loan');
      document.getElementById('btn-loan-save').textContent = 'Add Loan';
      ['lf-name', 'lf-lender', 'lf-principal', 'lf-monthly', 'lf-terms', 'lf-dueday', 'lf-startdate', 'lf-notes']
        .forEach(id => document.getElementById(id).value = '');
      document.getElementById('loan-modal-overlay').classList.add('open');
      document.getElementById('lf-name').focus();
    };

    function openEditLoan(id) {
      const l = loans.find(x => x.ID == id); if (!l) return;
      editLoanId = id;
      setText('loan-modal-title', 'Edit Loan');
      document.getElementById('btn-loan-save').textContent = 'Save Changes';
      document.getElementById('lf-name').value = l['Loan Name'] || '';
      document.getElementById('lf-lender').value = l.Lender || '';
      document.getElementById('lf-principal').value = l.Principal || '';
      document.getElementById('lf-monthly').value = l['Monthly Payment'] || '';
      document.getElementById('lf-terms').value = l.Terms || '';
      document.getElementById('lf-dueday').value = l['Due Day'] || '';
      document.getElementById('lf-startdate').value = l['Start Date'] || '';
      document.getElementById('lf-notes').value = l.Notes || '';
      document.getElementById('loan-modal-overlay').classList.add('open');
    }

    document.getElementById('btn-loan-save').onclick = async () => {
      const name = document.getElementById('lf-name').value.trim();
      const lender = document.getElementById('lf-lender').value.trim();
      const principal = parseFloat(document.getElementById('lf-principal').value);
      if (!name) { toast('⚠️ Loan Name is required'); return; }
      if (!lender) { toast('⚠️ Lender is required'); return; }
      if (!principal) { toast('⚠️ Principal amount is required'); return; }
      const payload = {
        'Loan Name': name, Lender: lender, Principal: principal,
        'Monthly Payment': parseFloat(document.getElementById('lf-monthly').value) || 0,
        Terms: document.getElementById('lf-terms').value.trim() || '',
        'Start Date': document.getElementById('lf-startdate').value || '',
        'Due Day': document.getElementById('lf-dueday').value || '',
        Notes: document.getElementById('lf-notes').value.trim() || ''
      };
      const btn = document.getElementById('btn-loan-save');
      btnLoad(btn, true, 'Saving…');
      try {
        if (editLoanId === null) {
          const r = await fetch('/api/loans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          const nl = await r.json(); if (nl.error) throw new Error(nl.error);
          loans.push(nl); toast('🎉 Loan added!');
        } else {
          const r = await fetch('/api/loans/' + editLoanId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          const ul = await r.json(); if (ul.error) throw new Error(ul.error);
          const i = loans.findIndex(x => x.ID == editLoanId); if (i !== -1) loans[i] = ul;
          toast('✏️ Loan updated!');
        }
        document.getElementById('loan-modal-overlay').classList.remove('open');
        renderLoans();
        const gl2 = currentGroupName ? ` · 🏠 ${currentGroupName}` : '';
        document.getElementById('page-sub').textContent = `${loans.length} loans${gl2}`;
      } catch (e) { toast('❌ ' + e.message); }
      finally { btnLoad(btn, false); }
    };

    document.getElementById('btn-loan-cancel').onclick = () =>
      document.getElementById('loan-modal-overlay').classList.remove('open');

    // ── Delete loan ───────────────────────────────────────────────
    function askDeleteLoan(id, name) {
      deleteLoanId = id;
      deleteContext = 'loan';
      document.getElementById('confirm-msg').textContent = `"${name}" and all its payments will be permanently deleted.`;
      document.getElementById('confirm-overlay').classList.add('open');
    }

    // ── Loan payments modal ───────────────────────────────────────
    function openLoanPayments(id) {
      const l = loans.find(x => x.ID == id); if (!l) return;
      viewLoanId = id;
      setText('pmt-loan-name', '💳 ' + l['Loan Name']);
      document.getElementById('pf-date').value = new Date().toISOString().slice(0, 10);
      document.getElementById('pf-amount').value = l['Monthly Payment'] || '';
      document.getElementById('pf-notes').value = '';
      refreshPmtModal(id);
      document.getElementById('loan-pmt-overlay').classList.add('open');
    }

    function refreshPmtModal(id) {
      const l = loans.find(x => x.ID == id); if (!l) return;
      const principal = parseFloat(l.Principal) || 0;
      const paid = loanTotalPaid(id);
      const remaining = Math.max(0, principal - paid);
      const pct = principal > 0 ? Math.min(100, Math.round((paid / principal) * 100)) : 0;
      setText('pmt-paid-label', fmt(paid) + ' paid');
      setText('pmt-remaining-label', fmt(remaining) + ' remaining');
      setText('pmt-pct-label', pct + '%');
      document.getElementById('pmt-progress').style.width = pct + '%';
      // Payment list
      const pmts = loanPmts(id).sort((a, b) => new Date(b['Payment Date']) - new Date(a['Payment Date']));
      const list = document.getElementById('pmt-list');
      if (!pmts.length) {
        list.innerHTML = '<div class="pmt-empty">No payments recorded yet. Add one above!</div>';
        return;
      }
      list.innerHTML = pmts.map(p => `
      <div class="pmt-row">
        <span class="pmt-date">📅 ${fmtDate(p['Payment Date'])}</span>
        <span class="pmt-amt">${fmt(p.Amount)}</span>
        <span class="pmt-note">${esc(p.Notes) || '—'}</span>
        <button class="btn-ic bi-del" style="flex-shrink:0;font-size:12px" title="Delete" onclick="deleteLoanPayment(${p.ID})">🗑</button>
      </div>`).join('');
    }

    document.getElementById('btn-add-payment').onclick = async () => {
      const amount = parseFloat(document.getElementById('pf-amount').value);
      const date = document.getElementById('pf-date').value;
      if (!amount || amount <= 0) { toast('⚠️ Amount is required'); return; }
      if (!date) { toast('⚠️ Payment date is required'); return; }
      const payload = {
        'Loan ID': viewLoanId, Amount: amount,
        'Payment Date': date,
        Notes: document.getElementById('pf-notes').value.trim()
      };
      const btn = document.getElementById('btn-add-payment');
      btnLoad(btn, true, '✅ Recording…');
      try {
        const r = await fetch('/api/loan-payments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const np = await r.json(); if (np.error) throw new Error(np.error);
        loanPayments.push(np);
        document.getElementById('pf-amount').value = '';
        document.getElementById('pf-notes').value = '';
        refreshPmtModal(viewLoanId);
        renderLoans();
        toast('✅ Payment recorded!');
      } catch (e) { toast('❌ ' + e.message); }
      finally { btnLoad(btn, false); }
    };

    async function deleteLoanPayment(pmtId) {
      if (!confirm('Delete this payment record?')) return;
      try {
        await fetch('/api/loan-payments/' + pmtId, { method: 'DELETE' });
        loanPayments = loanPayments.filter(p => p.ID != pmtId);
        refreshPmtModal(viewLoanId);
        renderLoans();
        toast('🗑️ Payment deleted.');
      } catch (e) { toast('❌ ' + e.message); }
    }

    document.getElementById('btn-pmt-close').onclick = () =>
      document.getElementById('loan-pmt-overlay').classList.remove('open');

    // ── Logout ────────────────────────────────────────────────────
    function toggleNavGroup() {
      const group = document.getElementById('nav-admin-group');
      group.classList.toggle('open');
    }

    async function doLogout() {
      try { await fetch('/api/logout', { method: 'POST' }); } finally {
        window.location.href = '/login';
      }
    }

    // ════════════════════════════════════════
    //  USERS (admin)
    // ════════════════════════════════════════
    let allUsers = [];
    let userFilter = 'all';
    let isAdminSession = false;
    let allGroups = [];
    let currentGroupName = '';
    let currentGroupCode = '';

    async function initSession() {
      try {
        const res = await fetch('/api/me');
        const data = await res.json();
        isAdminSession = data.isAdmin || false;
        currentGroupName = data.groupName || 'Admin';
        currentGroupCode = data.groupCode || 'admin';

        const wrap = document.getElementById('group-switcher-wrap');
        wrap.style.display = '';

        if (isAdminSession) {
          document.getElementById('nav-admin-group').style.display = '';
          document.getElementById('mn-users').style.display = '';
          document.getElementById('mn-groups').style.display = '';
          loadUsers();
          await loadGroups();          // populate switcher first
          buildGroupSwitcher();        // then render the select
        } else {
          // Non-admin: static badge showing their household
          const badge = document.getElementById('group-badge');
          badge.textContent = '🏠 ' + currentGroupName;
          badge.style.display = '';
          // Also show in sidebar footer
          const footer = document.querySelector('.sidebar-footer');
          const chip = document.createElement('div');
          chip.style.cssText = 'margin-top:6px;font-size:11px;color:rgba(255,255,255,.55);';
          chip.textContent = '🏠 ' + currentGroupName;
          footer.insertBefore(chip, footer.firstChild);
        }
      } catch { /* not admin or error */ }
    }

    function buildGroupSwitcher() {
      const sel = document.getElementById('group-switcher-select');
      sel.innerHTML =
        '<option value="__all__">📊 All Groups</option>' +
        '<option value="admin">🛡️ Admin (my data)</option>' +
        allGroups.map(g => `<option value="${g.Code}">🏠 ${g.Name}</option>`).join('');
      sel.value = currentGroupCode || '__all__';
      sel.style.display = '';
    }

    async function switchGroup(code) {
      const sel = document.getElementById('group-switcher-select');
      sel.disabled = true;
      try {
        // Tell server to change the active data file for this session
        const r = await fetch('/api/switch-group', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ groupCode: code })
        });
        const d = await r.json();
        if (d.error) throw new Error(d.error);
        currentGroupCode = code;
        currentGroupName = d.groupName;
        // Reload both data sets with the new group's file, then navigate to Bills
        await Promise.all([loadBills(), loadLoans()]);
        switchPage('bills');
        toast('🏠 Viewing: ' + d.groupName);
      } catch (e) {
        toast('❌ ' + e.message);
        sel.value = currentGroupCode; // revert dropdown on error
      } finally {
        sel.disabled = false;
      }
    }

    async function loadUsers() {
      try {
        const res = await fetch('/api/users');
        allUsers = await res.json();
        renderUsers();
        const pending = allUsers.filter(u => u.Status === 'Pending').length;
        const nb = document.getElementById('nav-pending-badge');
        const mnb = document.getElementById('mn-pending-badge');
        if (pending > 0) {
          nb.textContent = pending; nb.classList.add('show');
          mnb.textContent = pending; mnb.classList.add('show');
        } else {
          nb.classList.remove('show');
          mnb.classList.remove('show');
        }
      } catch (e) { toast('❌ Could not load users'); }
    }

    function renderUsers() {
      const filtered = userFilter === 'all'
        ? allUsers
        : allUsers.filter(u => (u.Status || 'Active') === userFilter);

      document.getElementById('users-count').textContent =
        filtered.length === allUsers.length
          ? `${allUsers.length} users`
          : `${filtered.length} of ${allUsers.length}`;

      const table = document.getElementById('users-table');
      const emEl = document.getElementById('users-empty');
      if (!filtered.length) {
        table.style.display = 'none'; emEl.style.display = '';
        return;
      }
      emEl.style.display = 'none'; table.style.display = '';

      document.getElementById('users-body').innerHTML = filtered.map(u => {
        const st = u.Status || 'Active';
        const stColor = st === 'Active' ? 'st-paid'
          : st === 'Pending' ? 'st-unpaid'
            : 'st-overdue';
        const stIcon = st === 'Active' ? '✅'
          : st === 'Pending' ? '⏳'
            : '🚫';
        const date = u.CreatedAt ? new Date(u.CreatedAt).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
        const isAdmin = u.Username.toLowerCase() === 'admin';

        const actions = isAdmin ? `
          <button class="btn-ic bi-edit" title="Change Password" onclick="openResetPw(${u.ID},'${esc(u.Username)}')">🔒</button>
        ` : `
          ${st === 'Pending' ? `<button class="btn-ic bi-pay"  title="Approve" onclick="openApproveConfirm(${u.ID},'${esc(u.Username)}','${esc(u.GroupCode || '')}','${esc(u.GroupName || u.GroupCode || '')}')">✓</button>` : ''}
          ${st === 'Active' ? `<button class="btn-ic bi-edit" title="Revoke"  onclick="rejectUser(${u.ID},'${esc(u.Username)}')">🚫</button>` : ''}
          ${st === 'Rejected' ? `<button class="btn-ic bi-pay"  title="Approve" onclick="openApproveConfirm(${u.ID},'${esc(u.Username)}','${esc(u.GroupCode || '')}','${esc(u.GroupName || u.GroupCode || '')}')">✓</button>` : ''}
          ${st === 'Pending' ? `<button class="btn-ic bi-del"  title="Reject"  onclick="rejectUser(${u.ID},'${esc(u.Username)}')">✗</button>` : ''}
          <button class="btn-ic" title="Change Group" style="background:#ede9fe;color:#6d28d9" onclick="openChangeGroup(${u.ID},'${esc(u.Username)}','${esc(u.GroupCode || '')}')">🏠</button>
          <button class="btn-ic bi-edit" title="Reset Password" onclick="openResetPw(${u.ID},'${esc(u.Username)}')">🔒</button>
          <button class="btn-ic bi-del"  title="Delete"         onclick="deleteUser(${u.ID},'${esc(u.Username)}')">🗑</button>
        `;
        const groupLabel = u.GroupName || u.GroupCode || '—';
        return `<tr>
          <td><span class="bill-id">#${u.ID}</span></td>
          <td><div class="bill-name">${esc(u.Username)}</div></td>
          <td><span class="muted-cell">🏠 ${esc(groupLabel)}</span></td>
          <td><span class="st-badge ${stColor}">${stIcon} ${st}</span></td>
          <td><span class="muted-cell">${date}</span></td>
          <td><div class="actions">${actions}</div></td>
        </tr>`;
      }).join('');
    }

    let _approveId = null, _approveName = '';

    async function openApproveConfirm(id, name, groupCode, groupName) {
      _approveId = id;
      _approveName = name;

      document.getElementById('approveconfirm-sub').textContent =
        `Reviewing membership for: ${name}`;
      document.getElementById('approveconfirm-alert').style.display = 'none';

      // populate group dropdown
      const sel = document.getElementById('approveconfirm-group');
      sel.innerHTML = '<option value="">Loading…</option>';
      try {
        const res = await fetch('/api/groups');
        const groups = await res.json();
        sel.innerHTML = groups.map(g =>
          `<option value="${esc(g.Code)}" ${g.Code === groupCode ? 'selected' : ''}>${esc(g.Name)}</option>`
        ).join('');
        if (!sel.value && groups.length) sel.value = groups[0].Code;
      } catch {
        sel.innerHTML = '<option value="">Cannot load groups</option>';
      }

      document.getElementById('approveconfirm-overlay').classList.add('open');
    }

    async function saveApproveConfirm() {
      const groupCode = document.getElementById('approveconfirm-group').value;
      const alertEl = document.getElementById('approveconfirm-alert');
      if (!groupCode) {
        alertEl.textContent = 'Please select a group before approving.';
        alertEl.style.display = 'block';
        return;
      }
      alertEl.style.display = 'none';

      const btn = document.getElementById('btn-approveconfirm-save');
      btnLoad(btn, true, '…');
      try {
        // 1. update group if needed
        const rg = await fetch('/api/users/' + _approveId + '/group', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ groupCode })
        });
        const dg = await rg.json(); if (dg.error) throw new Error(dg.error);

        // 2. approve
        const r = await fetch('/api/users/' + _approveId + '/approve', { method: 'PUT' });
        const d = await r.json(); if (d.error) throw new Error(d.error);

        document.getElementById('approveconfirm-overlay').classList.remove('open');
        toast('✅ ' + _approveName + ' approved!');
        await loadUsers();
      } catch (e) {
        alertEl.textContent = e.message;
        alertEl.style.display = 'block';
      } finally { btnLoad(btn, false); }
    }

    async function rejectUser(id, name) {
      const btn = event.target;
      btnLoad(btn, true, '…');
      try {
        const r = await fetch('/api/users/' + id + '/reject', { method: 'PUT' });
        const d = await r.json(); if (d.error) throw new Error(d.error);
        toast('🚫 ' + name + ' rejected.');
        await loadUsers();
      } catch (e) { toast('❌ ' + e.message); }
      finally { btnLoad(btn, false); }
    }

    async function deleteUser(id, name) {
      if (!confirm(`Delete user "${name}"? This cannot be undone.`)) return;
      try {
        const r = await fetch('/api/users/' + id, { method: 'DELETE' });
        const d = await r.json(); if (d.error) throw new Error(d.error);
        toast('🗑️ User deleted.');
        await loadUsers();
      } catch (e) { toast('❌ ' + e.message); }
    }

    // ── Help / Guide modal ────────────────────────────────────────
    let _helpStep = 0;
    const HELP_STEPS = ['🔐 Login', '📝 Register', '📊 Dashboard', '📋 Bills', '💳 Loans'];

    function openHelp() {
      _helpStep = 0;
      _renderHelpTabs();
      _showHelpSlide(0);
      document.getElementById('help-overlay').classList.add('open');
    }

    function closeHelp() {
      document.getElementById('help-overlay').classList.remove('open');
    }

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && document.getElementById('help-overlay').classList.contains('open')) closeHelp();
    });

    function helpNav(dir) {
      const next = _helpStep + dir;
      if (next < 0 || next >= HELP_STEPS.length) return;
      _showHelpSlide(next);
    }

    function _renderHelpTabs() {
      const container = document.getElementById('help-tabs');
      container.innerHTML = HELP_STEPS.map((label, i) =>
        `<button class="help-step-tab${i === _helpStep ? ' active' : ''}" onclick="_showHelpSlide(${i})">${label}</button>`
      ).join('');
    }

    function _showHelpSlide(n) {
      _helpStep = n;
      document.querySelectorAll('.help-slide').forEach((el, i) => {
        el.classList.toggle('active', i === n);
      });
      document.querySelectorAll('.help-step-tab').forEach((el, i) => {
        el.classList.toggle('active', i === n);
      });
      const counter = document.getElementById('help-counter');
      if (counter) counter.textContent = `Step ${n + 1} of ${HELP_STEPS.length}`;
      const prev = document.getElementById('btn-help-prev');
      const next = document.getElementById('btn-help-next');
      if (prev) prev.disabled = n === 0;
      if (next) {
        next.textContent = n === HELP_STEPS.length - 1 ? '✓ Done' : 'Next →';
        next.onclick = n === HELP_STEPS.length - 1 ? closeHelp : () => helpNav(1);
      }
    }

    // ── Change own password ───────────────────────────────────────
    function openChangePw() {
      document.getElementById('cpw-current').value = '';
      document.getElementById('cpw-new').value = '';
      document.getElementById('cpw-confirm').value = '';
      pwAlert('changepw-alert', '', '');
      document.getElementById('changepw-overlay').classList.add('open');
      document.getElementById('cpw-current').focus();
    }
    function closeChangePw() {
      document.getElementById('changepw-overlay').classList.remove('open');
    }
    async function saveChangePw() {
      const cur = document.getElementById('cpw-current').value;
      const np = document.getElementById('cpw-new').value;
      const conf = document.getElementById('cpw-confirm').value;
      if (!cur) return pwAlert('changepw-alert', 'error', 'Current password is required.');
      if (np.length < 6) return pwAlert('changepw-alert', 'error', 'New password must be at least 6 characters.');
      if (np !== conf) return pwAlert('changepw-alert', 'error', 'Passwords do not match.');
      const btn = document.getElementById('btn-changepw-save');
      btnLoad(btn, true, 'Saving…');
      try {
        const r = await fetch('/api/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword: cur, newPassword: np })
        });
        const d = await r.json();
        if (d.error) throw new Error(d.error);
        pwAlert('changepw-alert', 'success', '✅ Password updated successfully!');
        setTimeout(closeChangePw, 1500);
        toast('✅ Password changed!');
      } catch (e) { pwAlert('changepw-alert', 'error', e.message); }
      finally { btnLoad(btn, false, 'Update Password'); }
    }
    document.getElementById('changepw-overlay').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeChangePw();
    });

    // ── Admin reset user password ─────────────────────────────────
    let resetPwTargetId = null;
    function openResetPw(id, name) {
      resetPwTargetId = id;
      document.getElementById('resetpw-sub').textContent = `Reset password for: ${name}`;
      document.getElementById('rpw-new').value = '';
      document.getElementById('rpw-confirm').value = '';
      pwAlert('resetpw-alert', '', '');
      document.getElementById('resetpw-overlay').classList.add('open');
      document.getElementById('rpw-new').focus();
    }
    function closeResetPw() {
      document.getElementById('resetpw-overlay').classList.remove('open');
      resetPwTargetId = null;
    }
    async function saveResetPw() {
      const np = document.getElementById('rpw-new').value;
      const conf = document.getElementById('rpw-confirm').value;
      if (np.length < 6) return pwAlert('resetpw-alert', 'error', 'Password must be at least 6 characters.');
      if (np !== conf) return pwAlert('resetpw-alert', 'error', 'Passwords do not match.');
      const btn = document.getElementById('btn-resetpw-save');
      btnLoad(btn, true, 'Saving…');
      try {
        const r = await fetch(`/api/users/${resetPwTargetId}/reset-password`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newPassword: np })
        });
        const d = await r.json();
        if (d.error) throw new Error(d.error);
        pwAlert('resetpw-alert', 'success', '✅ Password reset successfully!');
        setTimeout(closeResetPw, 1500);
        toast('✅ Password reset!');
      } catch (e) { pwAlert('resetpw-alert', 'error', e.message); }
      finally { btnLoad(btn, false, 'Reset Password'); }
    }
    document.getElementById('resetpw-overlay').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeResetPw();
    });

    function pwAlert(elId, type, msg) {
      const el = document.getElementById(elId);
      if (!type) { el.style.display = 'none'; return; }
      el.style.display = 'flex';
      el.style.background = type === 'error' ? '#fef2f2' : '#f0fdf4';
      el.style.border = type === 'error' ? '1px solid #fecaca' : '1px solid #bbf7d0';
      el.style.color = type === 'error' ? '#991b1b' : '#166534';
      el.textContent = msg;
    }

    // ── Change user group ─────────────────────────────────────────
    let changeGroupTargetId = null;

    function openChangeGroup(id, username, currentCode) {
      changeGroupTargetId = id;
      document.getElementById('changegroup-sub').textContent = `User: ${username}`;
      pwAlert('changegroup-alert', '', '');
      // Populate dropdown with all groups
      const sel = document.getElementById('cg-group');
      sel.innerHTML = allGroups.map(g =>
        `<option value="${g.Code}" ${g.Code === currentCode ? 'selected' : ''}>${g.Name}</option>`
      ).join('');
      document.getElementById('changegroup-overlay').classList.add('open');
    }

    function closeChangeGroup() {
      document.getElementById('changegroup-overlay').classList.remove('open');
      changeGroupTargetId = null;
    }

    async function saveChangeGroup() {
      const groupCode = document.getElementById('cg-group').value;
      if (!groupCode) return pwAlert('changegroup-alert', 'error', 'Please select a group.');
      const btn = document.getElementById('btn-changegroup-save');
      btnLoad(btn, true, 'Saving…');
      try {
        const r = await fetch(`/api/users/${changeGroupTargetId}/group`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ groupCode })
        });
        const d = await r.json();
        if (d.error) throw new Error(d.error);
        const gName = allGroups.find(g => g.Code === groupCode)?.Name || groupCode;
        toast('✅ Moved to group: ' + gName);
        closeChangeGroup();
        await loadUsers();
      } catch (e) { pwAlert('changegroup-alert', 'error', e.message); }
      finally { btnLoad(btn, false, 'Save'); }
    }

    document.getElementById('changegroup-overlay').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeChangeGroup();
    });

    // ════ GROUPS ════════════════════════════════════════════
    async function loadGroups() {
      try {
        const res = await fetch('/api/groups');
        allGroups = await res.json();
        renderGroups();
        if (isAdminSession) buildGroupSwitcher();
      } catch (e) { toast('❌ Could not load groups'); }
    }

    function renderGroups() {
      const tbl = document.getElementById('groups-table');
      const em = document.getElementById('groups-empty');
      document.getElementById('groups-count').textContent = `${allGroups.length} groups`;
      if (!allGroups.length) { tbl.style.display = 'none'; em.style.display = ''; return; }
      em.style.display = 'none'; tbl.style.display = '';
      document.getElementById('groups-body').innerHTML = allGroups.map(g => {
        const date = g.CreatedAt ? new Date(g.CreatedAt).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
        return `<tr>
          <td><span class="bill-id">#${g.ID}</span></td>
          <td><div class="bill-name">🏠 ${esc(g.Name)}</div></td>
          <td><code style="background:var(--bg);padding:2px 6px;border-radius:5px;font-size:12px">${esc(g.Code)}</code></td>
          <td><span class="muted-cell">${esc(g.Description || '—')}</span></td>
          <td><span class="st-badge st-paid">${g.memberCount || 0} members</span></td>
          <td><span class="muted-cell">${date}</span></td>
          <td><div class="actions">
            <button class="btn-ic bi-del" title="Delete" onclick="deleteGroup(${g.ID},'${esc(g.Name)}',${g.memberCount || 0})">🗑</button>
          </div></td>
        </tr>`;
      }).join('');
    }

    let groupModalEdit = null;

    function autoGroupCode(name) {
      const lock = document.getElementById('gf-code-lock');
      if (lock.dataset.manual === 'true') return; // user typed their own code — don't overwrite
      const code = name.trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')   // non-alphanumeric → underscore
        .replace(/^_+|_+$/g, '')        // trim leading/trailing underscores
        .slice(0, 20);
      document.getElementById('gf-code').value = code;
    }

    function openGroupModal() {
      groupModalEdit = null;
      document.getElementById('gf-name').value = '';
      document.getElementById('gf-code').value = '';
      document.getElementById('gf-desc').value = '';
      const lock = document.getElementById('gf-code-lock');
      lock.textContent = 'auto ✨';
      lock.dataset.manual = 'false';
      document.getElementById('group-modal-title').textContent = 'Add Group';
      document.getElementById('group-modal-overlay').classList.add('open');
      document.getElementById('gf-name').focus();
    }

    function closeGroupModal() {
      document.getElementById('group-modal-overlay').classList.remove('open');
    }

    async function saveGroup() {
      const name = document.getElementById('gf-name').value.trim();
      const code = document.getElementById('gf-code').value.trim().toLowerCase();
      const desc = document.getElementById('gf-desc').value.trim();
      if (!name) return toast('⚠️ Group name is required');
      if (!code) return toast('⚠️ Group code is required');
      if (!/^[a-zA-Z0-9_-]{2,20}$/.test(code)) return toast('⚠️ Code: 2–20 chars, letters/numbers/_ - only');
      const btn = document.getElementById('btn-group-save');
      btnLoad(btn, true, 'Saving…');
      try {
        const r = await fetch('/api/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, code, description: desc })
        });
        const d = await r.json();
        if (d.error) throw new Error(d.error);
        toast('✅ Group "' + name + '" created!');
        closeGroupModal();
        await loadGroups();
        document.getElementById('page-sub').textContent = `${allGroups.length} groups`;
      } catch (e) { toast('❌ ' + e.message); }
      finally { btnLoad(btn, false, 'Save Group'); }
    }

    async function deleteGroup(id, name, memberCount) {
      if (memberCount > 0) return toast('⚠️ Cannot delete a group with members');
      if (!confirm(`Delete group "${name}"?`)) return;
      try {
        const r = await fetch('/api/groups/' + id, { method: 'DELETE' });
        const d = await r.json(); if (d.error) throw new Error(d.error);
        toast('🗑️ Group deleted.');
        await loadGroups();
      } catch (e) { toast('❌ ' + e.message); }
    }

    document.getElementById('group-modal-overlay').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeGroupModal();
    });

    // If admin manually edits the code field, stop auto-generating
    document.getElementById('gf-code').addEventListener('input', () => {
      const lock = document.getElementById('gf-code-lock');
      lock.textContent = '✏️';
      lock.dataset.manual = 'true';
    });

    document.querySelectorAll('.tab[data-user-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab[data-user-filter]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        userFilter = btn.dataset.userFilter;
        renderUsers();
      });
    });

    // ── Loan filter tabs ──────────────────────────────────────────
    document.querySelectorAll('.tab[data-loan-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab[data-loan-filter]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        loanFilterStatus = btn.dataset.loanFilter;
        renderLoans();
      });
    });
    document.getElementById('loan-search').addEventListener('input', renderLoans);

    // ════════════════════════════════════════
    //  NOTIFICATION BELL
    // ════════════════════════════════════════

    function buildNotifications() {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const in7 = new Date(today); in7.setDate(in7.getDate() + 7);
      const ago7 = new Date(today); ago7.setDate(ago7.getDate() - 7);

      const overdue = [];
      const dueSoon = [];
      const recentlyPaid = [];

      bills.forEach(b => {
        const st = effectiveStatus(b);
        if (!b['Due Date']) return;
        const due = new Date(b['Due Date']); due.setHours(0, 0, 0, 0);

        if (st === 'Overdue') {
          overdue.push(b);
        } else if (st === 'Unpaid' && due >= today && due <= in7) {
          dueSoon.push(b);
        }
        if (st === 'Paid' && b['Payment Date']) {
          const pd = new Date(b['Payment Date']); pd.setHours(0, 0, 0, 0);
          if (pd >= ago7) recentlyPaid.push(b);
        }
      });

      // Sort
      overdue.sort((a, b) => new Date(a['Due Date']) - new Date(b['Due Date']));
      dueSoon.sort((a, b) => new Date(a['Due Date']) - new Date(b['Due Date']));
      recentlyPaid.sort((a, b) => new Date(b['Payment Date']) - new Date(a['Payment Date']));

      return { overdue, dueSoon, recentlyPaid };
    }

    function daysLabel(dateStr) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const d = new Date(dateStr); d.setHours(0, 0, 0, 0);
      const diff = Math.round((d - today) / 86400000);
      if (diff === 0) return 'Due today';
      if (diff === 1) return 'Due tomorrow';
      if (diff < 0) return Math.abs(diff) + ' day' + (Math.abs(diff) > 1 ? 's' : '') + ' overdue';
      return 'Due in ' + diff + ' day' + (diff > 1 ? 's' : '');
    }

    function updateNotifBadge() {
      const { overdue, dueSoon } = buildNotifications();
      const count = overdue.length + dueSoon.length;
      const badge = document.getElementById('notif-badge');
      badge.textContent = count > 99 ? '99+' : count;
      badge.style.display = count > 0 ? 'flex' : 'none';
    }

    function renderNotifPanel() {
      const { overdue, dueSoon, recentlyPaid } = buildNotifications();
      const total = overdue.length + dueSoon.length;
      document.getElementById('notif-count-label').textContent =
        total > 0 ? total + ' action needed' : 'All clear';

      const body = document.getElementById('notif-body');
      let html = '';

      if (!overdue.length && !dueSoon.length && !recentlyPaid.length) {
        html = `<div class="notif-empty">🎉 No pending bills or recent activity.</div>`;
      }

      if (overdue.length) {
        html += `<div class="notif-section-label">🚨 Overdue (${overdue.length})</div>`;
        html += overdue.map(b => `
        <div class="notif-item">
          <span class="notif-icon">❗</span>
          <div class="notif-body">
            <div class="notif-name">${esc(b['Bill Name'])}</div>
            <div class="notif-meta" style="color:#ef4444">${daysLabel(b['Due Date'])} · ${esc(b.Category || '')}</div>
          </div>
          <span class="notif-amt" style="color:#ef4444">${fmt(b.Amount)}</span>
        </div>`).join('');
      }

      if (dueSoon.length) {
        html += `<div class="notif-section-label">⏰ Due Soon (${dueSoon.length})</div>`;
        html += dueSoon.map(b => `
        <div class="notif-item">
          <span class="notif-icon">📅</span>
          <div class="notif-body">
            <div class="notif-name">${esc(b['Bill Name'])}</div>
            <div class="notif-meta" style="color:#f59e0b">${daysLabel(b['Due Date'])} · ${esc(b.Category || '')}</div>
          </div>
          <span class="notif-amt" style="color:#f59e0b">${fmt(b.Amount)}</span>
        </div>`).join('');
      }

      if (recentlyPaid.length) {
        html += `<div class="notif-section-label">✅ Recently Paid (${recentlyPaid.length})</div>`;
        html += recentlyPaid.map(b => `
        <div class="notif-item">
          <span class="notif-icon">✅</span>
          <div class="notif-body">
            <div class="notif-name">${esc(b['Bill Name'])}</div>
            <div class="notif-meta" style="color:var(--success)">Paid ${fmtDate(b['Payment Date'])} · ${esc(b.Category || '')}</div>
          </div>
          <span class="notif-amt" style="color:var(--success)">${fmt(b.Amount)}</span>
        </div>`).join('');
      }

      body.innerHTML = html;
    }

    document.getElementById('btn-bell').addEventListener('click', e => {
      e.stopPropagation();
      const panel = document.getElementById('notif-panel');
      const opening = !panel.classList.contains('open');
      panel.classList.toggle('open');
      if (opening) renderNotifPanel();
    });

    // Close panel when clicking anywhere outside
    document.addEventListener('click', e => {
      const wrap = document.querySelector('.notif-wrap');
      if (!wrap.contains(e.target)) {
        document.getElementById('notif-panel').classList.remove('open');
      }
    });

    // ════════════════════════════════════════
    //  DARK MODE
    // ════════════════════════════════════════
    (function initTheme() {
      const saved = localStorage.getItem('theme') || 'light';
      document.documentElement.setAttribute('data-theme', saved);
      document.getElementById('btn-theme').textContent = saved === 'dark' ? '☀️' : '🌙';
    })();

    document.getElementById('btn-theme').addEventListener('click', () => {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const next = isDark ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      document.getElementById('btn-theme').textContent = next === 'dark' ? '☀️' : '🌙';
      localStorage.setItem('theme', next);
    });

    // ════════════════════════════════════════
    //  SPENDING CHARTS
    // ════════════════════════════════════════
    let chartCategory = null;
    let chartMonthly = null;

    function renderCharts(src) {
      if (typeof Chart === 'undefined') return;

      // Category doughnut — use ALL bills in the period (not just paid)
      const cats = {};
      src.forEach(b => {
        const c = b.Category || 'Others';
        cats[c] = (cats[c] || 0) + (parseFloat(b.Amount) || 0);
      });
      const palette = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#0ea5e9', '#f97316', '#14b8a6', '#ec4899'];
      const catLabels = Object.keys(cats);
      const catData = catLabels.map(k => cats[k]);
      const catColors = catLabels.map((_, i) => palette[i % palette.length]);

      if (chartCategory) { chartCategory.destroy(); chartCategory = null; }
      const ctxCat = document.getElementById('chart-category').getContext('2d');
      chartCategory = new Chart(ctxCat, {
        type: 'doughnut',
        data: {
          labels: catLabels.length ? catLabels : ['No Bills'],
          datasets: [{
            data: catLabels.length ? catData : [1],
            backgroundColor: catLabels.length ? catColors : ['#e2e8f0'],
            borderWidth: 2, borderColor: '#fff'
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { position: 'right', labels: { font: { size: 11 }, boxWidth: 12, padding: 8 } },
            tooltip: {
              callbacks: {
                label: ctx => {
                  const val = ctx.parsed;
                  const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                  const pct = total > 0 ? Math.round((val / total) * 100) : 0;
                  return ` ₱${val.toLocaleString('en-PH', { minimumFractionDigits: 2 })} (${pct}%)`;
                }
              }
            }
          }
        }
      });

      // Monthly bar (last 6 months, total billed vs paid)
      const months = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
        months.push(d.toISOString().slice(0, 7));
      }
      const totalByMonth = months.map(m => bills.filter(b => b['Due Date'] && b['Due Date'].slice(0, 7) === m).reduce((s, b) => s + (parseFloat(b.Amount) || 0), 0));
      const paidByMonth = months.map(m => bills.filter(b => b['Due Date'] && b['Due Date'].slice(0, 7) === m && effectiveStatus(b) === 'Paid').reduce((s, b) => s + (parseFloat(b.Amount) || 0), 0));

      if (chartMonthly) chartMonthly.destroy();
      const ctxMo = document.getElementById('chart-monthly').getContext('2d');
      chartMonthly = new Chart(ctxMo, {
        type: 'bar',
        data: {
          labels: months.map(m => { const d = new Date(m + '-01'); return d.toLocaleString('default', { month: 'short', year: '2-digit' }); }),
          datasets: [
            { label: 'Total', data: totalByMonth, backgroundColor: 'rgba(99,102,241,.25)', borderColor: '#6366f1', borderWidth: 2, borderRadius: 4 },
            { label: 'Paid', data: paidByMonth, backgroundColor: 'rgba(34,197,94,.4)', borderColor: '#22c55e', borderWidth: 2, borderRadius: 4 }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { labels: { font: { size: 11 }, boxWidth: 12 } } },
          scales: { y: { beginAtZero: true, ticks: { callback: v => '₱' + v.toLocaleString() } } }
        }
      });

      renderBudgetBars(src);
    }

    // ════════════════════════════════════════
    //  BUDGET LIMITS
    // ════════════════════════════════════════
    const BUDGET_KEY = 'expense-budgets';
    const CATEGORIES = ['Utilities', 'Rent', 'Internet', 'Phone', 'Insurance', 'Supplies', 'Salary', 'Government', 'Others'];

    function loadBudgets() {
      try { return JSON.parse(localStorage.getItem(BUDGET_KEY)) || {}; }
      catch { return {}; }
    }

    function renderBudgetBars(src) {
      const budgets = loadBudgets();
      const active = CATEGORIES.filter(c => budgets[c] > 0);
      if (!active.length) { document.getElementById('budget-bars').innerHTML = ''; return; }
      const now = new Date();
      const mo = now.toISOString().slice(0, 7);
      const spent = {};
      src.filter(b => b['Due Date'] && b['Due Date'].slice(0, 7) === mo).forEach(b => {
        const c = b.Category || 'Others';
        spent[c] = (spent[c] || 0) + (parseFloat(b.Amount) || 0);
      });
      document.getElementById('budget-bars').innerHTML = active.map(cat => {
        const limit = budgets[cat];
        const s = spent[cat] || 0;
        const pct = Math.min(100, Math.round((s / limit) * 100));
        const color = pct >= 100 ? '#ef4444' : pct >= 80 ? '#f59e0b' : '#22c55e';
        return `<div class="budget-item">
        <span class="budget-label">${cat}</span>
        <div class="budget-bar-wrap"><div class="budget-bar" style="width:${pct}%;background:${color}"></div></div>
        <span class="budget-pct" style="color:${color}">${pct}%</span>
      </div>`;
      }).join('');
    }

    function openBudgetSettings() {
      const budgets = loadBudgets();
      document.getElementById('budget-fields').innerHTML = CATEGORIES.map(cat => `
      <div class="field">
        <label>${cat}</label>
        <input type="number" data-budget-cat="${cat}" placeholder="₱ limit" min="0" step="100"
          value="${budgets[cat] || ''}" style="width:100%" />
      </div>`).join('');
      document.getElementById('budget-modal-overlay').classList.add('open');
    }

    document.getElementById('btn-budget-save').onclick = () => {
      const budgets = {};
      document.querySelectorAll('[data-budget-cat]').forEach(inp => {
        const v = parseFloat(inp.value);
        if (v > 0) budgets[inp.dataset.budgetCat] = v;
      });
      localStorage.setItem(BUDGET_KEY, JSON.stringify(budgets));
      document.getElementById('budget-modal-overlay').classList.remove('open');
      renderCharts(bills); toast('✅ Budget limits saved!');
    };
    document.getElementById('btn-budget-cancel').onclick = () =>
      document.getElementById('budget-modal-overlay').classList.remove('open');
    document.getElementById('budget-modal-overlay').addEventListener('click', e => {
      if (e.target.id === 'budget-modal-overlay') document.getElementById('budget-modal-overlay').classList.remove('open');
    });

    // Wire charts into updateDashboard — patch in after bills filter
    const _origUpdateDashboard = updateDashboard;
    updateDashboard = function () {
      _origUpdateDashboard();
      let src = bills;
      if (dashFilterMonth) src = src.filter(b => b['Due Date'] && b['Due Date'].slice(0, 7) === dashFilterMonth);
      if (dashFilterCutoff) src = src.filter(b => matchesCutoff(b, dashFilterCutoff));
      renderCharts(src);
    };

    // ════════════════════════════════════════
    //  CALENDAR VIEW
    // ════════════════════════════════════════
    let calYear = new Date().getFullYear();
    let calMonth = new Date().getMonth();

    function setView(v) {
      document.getElementById('list-view').style.display = v === 'list' ? '' : 'none';
      document.getElementById('cal-view').style.display = v === 'calendar' ? '' : 'none';
      document.getElementById('btn-list-view').classList.toggle('active', v === 'list');
      document.getElementById('btn-cal-view').classList.toggle('active', v === 'calendar');
      if (v === 'calendar') renderCalendar();
    }

    function calPrev() { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar(); }
    function calNext() { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar(); }

    function renderCalendar() {
      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      document.getElementById('cal-month-label').textContent = `${monthNames[calMonth]} ${calYear}`;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const first = new Date(calYear, calMonth, 1);
      const last = new Date(calYear, calMonth + 1, 0);
      const startDow = first.getDay();
      const cells = [];
      // padding cells before
      const prevLast = new Date(calYear, calMonth, 0).getDate();
      for (let i = startDow - 1; i >= 0; i--) cells.push({ day: prevLast - i, cur: false });
      // current month
      for (let d = 1; d <= last.getDate(); d++) cells.push({ day: d, cur: true });
      // padding after
      const rem = 7 - (cells.length % 7); if (rem < 7) for (let d = 1; d <= rem; d++) cells.push({ day: d, cur: false });

      // Map bills to day
      const byDay = {};
      bills.forEach(b => {
        if (!b['Due Date']) return;
        const bd = new Date(b['Due Date']); bd.setHours(0, 0, 0, 0);
        if (bd.getFullYear() !== calYear || bd.getMonth() !== calMonth) return;
        const d = bd.getDate(); if (!byDay[d]) byDay[d] = [];
        byDay[d].push(b);
      });

      document.getElementById('cal-grid').innerHTML = cells.map(c => {
        const isToday = c.cur && c.day === today.getDate() && today.getFullYear() === calYear && today.getMonth() === calMonth;
        const bs = c.cur ? (byDay[c.day] || []) : [];
        const dotsHtml = bs.slice(0, 3).map(b => {
          const st = effectiveStatus(b);
          const cls = st === 'Paid' ? 'cal-dot-paid' : st === 'Overdue' ? 'cal-dot-overdue' : 'cal-dot-unpaid';
          return `<div class="cal-bill-dot ${cls}">${esc(b['Bill Name'])}</div>`;
        }).join('') + (bs.length > 3 ? `<div class="cal-bill-dot" style="color:var(--muted)">+${bs.length - 3} more</div>` : '');
        return `<div class="cal-cell${!c.cur ? ' other-month' : ''}${isToday ? ' today' : ''}">
        <div class="cal-day-num">${c.day}</div>
        ${dotsHtml}
      </div>`;
      }).join('');
    }

    // ════════════════════════════════════════
    //  LOAN ALERTS IN BELL
    // ════════════════════════════════════════
    const _origBuildNotifications = buildNotifications;
    buildNotifications = function () {
      const base = _origBuildNotifications();
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const in7 = new Date(today); in7.setDate(in7.getDate() + 7);
      const overdueLns = [];
      const dueSoonLns = [];
      loans.forEach(l => {
        const st = effectiveLoanStatus(l);
        if (st === 'Overdue') { overdueLns.push(l); return; }
        if (st === 'Active' && l['Due Day']) {
          const now2 = new Date();
          const due2 = new Date(now2.getFullYear(), now2.getMonth(), parseInt(l['Due Day']));
          due2.setHours(0, 0, 0, 0);
          if (due2 >= today && due2 <= in7) dueSoonLns.push(l);
        }
      });
      return { ...base, overdueLns, dueSoonLns };
    };

    const _origUpdateNotifBadge = updateNotifBadge;
    updateNotifBadge = function () {
      const { overdue, dueSoon, overdueLns, dueSoonLns } = buildNotifications();
      const count = overdue.length + dueSoon.length + overdueLns.length + dueSoonLns.length;
      const badge = document.getElementById('notif-badge');
      badge.textContent = count > 99 ? '99+' : count;
      badge.style.display = count > 0 ? 'flex' : 'none';
    };

    const _origRenderNotifPanel = renderNotifPanel;
    renderNotifPanel = function () {
      _origRenderNotifPanel();
      const { overdueLns, dueSoonLns } = buildNotifications();
      if (!overdueLns.length && !dueSoonLns.length) return;
      const body = document.getElementById('notif-body');
      let extra = '';
      if (overdueLns.length) {
        extra += `<div class="notif-section-label">🚨 Loans Overdue (${overdueLns.length})</div>`;
        extra += overdueLns.map(l => `<div class="notif-item"><span class="notif-icon">💳</span><div class="notif-body"><div class="notif-name">${esc(l['Loan Name'])}</div><div class="notif-meta" style="color:#ef4444">Overdue · ${esc(l.Lender || '')}</div></div><span class="notif-amt" style="color:#ef4444">${fmt(l['Monthly Payment'])}</span></div>`).join('');
      }
      if (dueSoonLns.length) {
        extra += `<div class="notif-section-label">⏰ Loans Due Soon (${dueSoonLns.length})</div>`;
        extra += dueSoonLns.map(l => `<div class="notif-item"><span class="notif-icon">💳</span><div class="notif-body"><div class="notif-name">${esc(l['Loan Name'])}</div><div class="notif-meta" style="color:#f59e0b">Due day ${l['Due Day']} · ${esc(l.Lender || '')}</div></div><span class="notif-amt" style="color:#f59e0b">${fmt(l['Monthly Payment'])}</span></div>`).join('');
      }
      body.insertAdjacentHTML('beforeend', extra);
      // Update count label
      const { overdue, dueSoon } = buildNotifications();
      const total = overdue.length + dueSoon.length + overdueLns.length + dueSoonLns.length;
      document.getElementById('notif-count-label').textContent = total > 0 ? total + ' action needed' : 'All clear';
    };


