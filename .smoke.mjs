import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const PROFILE = '.chrome-smoke';
const URL = pathToFileURL(process.cwd() + '/index.html').href;

let chrome;
let socket;
let nextId = 1;
const pending = new Map();
const errors = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', {
    expression: `(() => { ${expression} })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || 'evaluate failed');
  }
  return response.result.value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value) return value;
    await sleep(100);
  }
  return false;
}

// Intl id-ID menulis spasi tak-terputus (U+00A0) pada "Rp 150.000";
// samakan dulu sebelum membandingkan teks.
const clean = (value) => String(value ?? '').replace(/[\u00a0\u202f]/g, ' ').trim();

const TODAY = (() => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
})();

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition ? '' : ` -> ${detail}`}`);
}

try {
  chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--allow-file-access-from-files',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${process.cwd()}/${PROFILE}`,
    URL,
  ], { stdio: 'ignore' });

  const target = await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      return list.find((t) => t.type === 'page') || false;
    } catch {
      return false;
    }
  }, 10000);

  if (!target) throw new Error('Chrome target not available');

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.exception?.description || 'exception');
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      errors.push(message.params.entry.text);
    }
  };

  await send('Runtime.enable');
  await send('Log.enable');

  const ready = await waitFor(() => evaluate('return document.readyState === "complete" && !!document.getElementById("transactionForm");'), 10000);
  check('page initialized', ready);

  // 0. Branding WALLE
  const branding = await evaluate(`
    const mark = document.querySelector('.brand-mark');
    return {
      title: document.title,
      brand: document.querySelector('.brand-name')?.textContent,
      ariaLabel: document.querySelector('.brand')?.getAttribute('aria-label'),
      tag: document.querySelector('.brand-tag')?.textContent,
      footer: document.querySelector('.footer')?.textContent,
      favicon: document.querySelector('link[rel="icon"]')?.getAttribute('href'),
      markSrc: mark.querySelector('img')?.getAttribute('src'),
      markLoaded: (mark.querySelector('img')?.naturalWidth || 0) > 0,
      bodyText: document.body.innerText,
    };
  `);
  check('tab title is WALLE', branding.title === 'WALLE', branding.title);
  check('header brand shows WALLE', branding.brand === 'WALLE' && /keuangan/i.test(branding.tag || ''), JSON.stringify(branding));
  check('brand aria-label updated', /^WALLE\b/.test(branding.ariaLabel || ''), branding.ariaLabel);
  check('footer mentions WALLE', /WALLE/.test(branding.footer || ''), branding.footer);
  check('no MYFINANCE left in visible text', !/myfinance/i.test(branding.bodyText), 'still present');
  const faviconSvg = decodeURIComponent(branding.favicon || '');
  check('favicon uses navy + W geometry', /0d2550/i.test(faviconSvg) && /38bdf8/i.test(faviconSvg) && /M6\.25 14\.25/.test(faviconSvg), branding.favicon);
  check('navbar renders SVG logo', branding.markSrc === 'walle-mark.svg' && branding.markLoaded, JSON.stringify({ src: branding.markSrc, loaded: branding.markLoaded }));

  // Reset storage for a clean run.
  await evaluate('localStorage.removeItem("myfinance:transactions:v1"); return true;');

  // 1. Validation: empty amount/category
  const invalid = await evaluate(`
    document.getElementById('amountInput').value = '';
    document.getElementById('categorySelect').value = '';
    document.getElementById('transactionForm').requestSubmit();
    return {
      amountError: document.getElementById('amountError').textContent,
      categoryError: document.getElementById('categoryError').textContent,
      amountInvalid: document.getElementById('amountInput').classList.contains('is-invalid'),
      items: document.querySelectorAll('.tx-item').length,
      storage: localStorage.getItem('myfinance:transactions:v1')
    };
  `);
  check('validation blocks empty amount', invalid.amountError.length > 0 && invalid.items === 0, JSON.stringify(invalid));
  check('validation blocks empty category', invalid.categoryError.length > 0, JSON.stringify(invalid));
  check('invalid field styled', invalid.amountInvalid);

  // 2. Add income
  const added = await evaluate(`
    document.getElementById('toastStack').replaceChildren();
    document.getElementById('amountInput').value = '150000';
    document.getElementById('categorySelect').value = 'Gaji';
    document.getElementById('dateInput').value = '2026-11-25';
    document.getElementById('noteInput').value = 'Gaji bulanan';
    document.getElementById('transactionForm').requestSubmit();
    return {
      storage: JSON.parse(localStorage.getItem('myfinance:transactions:v1') || '[]'),
      balance: document.getElementById('balanceValue').textContent,
      income: document.getElementById('incomeValue').textContent,
      count: document.getElementById('historyCount').textContent,
      items: document.querySelectorAll('.tx-item').length,
      toast: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()).join('|'),
      amountCleared: document.getElementById('amountInput').value,
      categoryCleared: document.getElementById('categorySelect').value,
      noteCleared: document.getElementById('noteInput').value
    };
  `);
  check('income saved to localStorage', added.storage.length === 1 && added.storage[0].amount === 150000, JSON.stringify(added.storage));
  check('income updates balance', clean(added.balance) === 'Rp 150.000', added.balance);
  check('income list renders', added.items === 1 && added.count === '1 transaksi', `${added.items}/${added.count}`);
  check('toast shown on add', clean(added.toast).includes('berhasil ditambahkan'), added.toast);
  check('form reset after add', added.amountCleared === '' && added.categoryCleared === '' && added.noteCleared === '');

  // 3. Add expense via type toggle
  const expense = await evaluate(`
    document.querySelector('[data-form-type="expense"]').click();
    document.getElementById('amountInput').value = '50000';
    document.getElementById('categorySelect').value = 'Makanan';
    document.getElementById('dateInput').value = '2026-11-24';
    document.getElementById('noteInput').value = 'Makan siang';
    document.getElementById('transactionForm').requestSubmit();
    return {
      stored: JSON.parse(localStorage.getItem('myfinance:transactions:v1') || '[]').length,
      balance: document.getElementById('balanceValue').textContent,
      expense: document.getElementById('expenseValue').textContent,
      items: document.querySelectorAll('.tx-item').length,
      firstTitle: document.querySelector('.tx-item .tx-title')?.textContent
    };
  `);
  check('expense saved', expense.stored === 2, JSON.stringify(expense));
  check('balance accounts for expense', clean(expense.balance) === 'Rp 100.000', expense.balance);
  check('expense total correct', clean(expense.expense) === 'Rp 50.000', expense.expense);
  check('list sorts newest first', expense.firstTitle === 'Gaji', expense.firstTitle);

  // 4. Filters + search
  const filtered = await evaluate(`
    const typeFilter = document.getElementById('typeFilter');
    typeFilter.value = 'expense';
    typeFilter.dispatchEvent(new Event('change', { bubbles: true }));
    const expenseOnly = document.querySelectorAll('.tx-item').length;
    const subExpense = document.getElementById('historySub').textContent;

    typeFilter.value = 'all';
    typeFilter.dispatchEvent(new Event('change', { bubbles: true }));

    const search = document.getElementById('searchInput');
    search.value = 'gaji';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const searchCount = document.querySelectorAll('.tx-item').length;

    search.value = 'tidak-ada';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const emptyVisible = !!document.querySelector('#transactionList .empty-state');
    const emptyTitle = document.querySelector('#transactionList .empty-state h3')?.textContent || '';

    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));

    const categoryFilter = document.getElementById('categoryFilter');
    categoryFilter.value = 'Makanan';
    categoryFilter.dispatchEvent(new Event('change', { bubbles: true }));
    const categoryCount = document.querySelectorAll('.tx-item').length;
    categoryFilter.value = 'all';
    categoryFilter.dispatchEvent(new Event('change', { bubbles: true }));

    return { expenseOnly, subExpense, searchCount, emptyVisible, emptyTitle, categoryCount };
  `);
  check('type filter works', filtered.expenseOnly === 1, JSON.stringify(filtered));
  check('filter summary updates', filtered.subExpense.includes('1 dari 2'), filtered.subExpense);
  check('search works', filtered.searchCount === 1, JSON.stringify(filtered));
  check('no-result empty state', filtered.emptyVisible && filtered.emptyTitle === 'Transaksi tidak ditemukan', JSON.stringify(filtered));
  check('category filter works', filtered.categoryCount === 1, JSON.stringify(filtered));

  // 5. Edit first transaction
  const edited = await evaluate(`
    const item = [...document.querySelectorAll('.tx-item')].find(el => el.querySelector('.tx-title').textContent === 'Gaji');
    item.querySelector('[data-action="edit"]').click();
    const opened = !document.getElementById('editModal').hidden;
    const modalAmount = document.getElementById('editAmount').value;
    const modalCategory = document.getElementById('editCategory').value;
    document.getElementById('editAmount').value = '175000';
    document.getElementById('editForm').requestSubmit();
    return {
      opened,
      modalAmount,
      modalCategory,
      hiddenAfter: document.getElementById('editModal').hidden,
      storedAmount: JSON.parse(localStorage.getItem('myfinance:transactions:v1') || '[]').find(t => t.category === 'Gaji')?.amount,
      balance: document.getElementById('balanceValue').textContent,
      toast: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()).join('|')
    };
  `);
  check('edit modal opens with data', edited.opened && edited.modalAmount === '150000' && edited.modalCategory === 'Gaji', JSON.stringify(edited));
  check('edit saves to localStorage', edited.storedAmount === 175000 && edited.hiddenAfter === true, JSON.stringify(edited));
  check('edit updates balance', clean(edited.balance) === 'Rp 125.000', edited.balance);
  check('toast shown on edit', edited.toast.includes('Perubahan transaksi berhasil disimpan'), edited.toast);

  // 6. Chart rendering
  const chart = await evaluate(`
    const canvas = document.getElementById('cashflowChart');
    return {
      emptyHidden: document.getElementById('chartEmpty').hidden,
      canvasHidden: canvas.hidden,
      width: canvas.width,
      height: canvas.height,
      dataUrlLength: canvas.toDataURL().length
    };
  `);
  check('chart renders when data exists', chart.emptyHidden && !chart.canvasHidden && chart.width > 0 && chart.dataUrlLength > 2000, JSON.stringify(chart));

  // 7. Delete transaction
  const deleted = await evaluate(`
    const item = [...document.querySelectorAll('.tx-item')].find(el => el.querySelector('.tx-title').textContent === 'Makanan');
    item.querySelector('[data-action="delete"]').click();
    const opened = !document.getElementById('deleteModal').hidden;
    const summary = document.getElementById('deleteSummary').textContent;
    document.getElementById('confirmDeleteBtn').click();
    return {
      opened,
      summary,
      hiddenAfter: document.getElementById('deleteModal').hidden,
      stored: JSON.parse(localStorage.getItem('myfinance:transactions:v1') || '[]').length,
      items: document.querySelectorAll('.tx-item').length,
      toast: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()).join('|')
    };
  `);
  check('delete modal opens with summary', deleted.opened && clean(deleted.summary).includes('Makanan') && clean(deleted.summary).includes('Rp 50.000'), JSON.stringify(deleted));
  check('delete persists', deleted.stored === 1 && deleted.items === 1 && deleted.hiddenAfter, JSON.stringify(deleted));
  check('toast shown on delete', deleted.toast.includes('dihapus'), deleted.toast);

  // 8. Persistence across reload
  await send('Page.enable');
  await send('Page.reload');
  await sleep(500);
  const reloaded = await waitFor(async () => {
    const state = await evaluate(`
      return {
        ready: document.readyState === 'complete' && document.querySelectorAll('.tx-item').length > 0,
        balance: document.getElementById('balanceValue')?.textContent,
        items: document.querySelectorAll('.tx-item').length
      };
    `);
    return state.ready ? state : false;
  }, 8000);
  check('data persists after reload', reloaded && clean(reloaded.balance) === 'Rp 175.000' && reloaded.items === 1, JSON.stringify(reloaded));

  // 9. resetAddForm(): semua kolom bersih, tanggal kembali ke hari ini,
  //    pesan error tersembunyi, dan jenis transaksi tetap dipertahankan.
  const reset = await evaluate(`
    document.getElementById('toastStack').replaceChildren();
    document.querySelector('[data-form-type="expense"]').click();
    document.getElementById('amountInput').value = '10000';
    document.getElementById('categorySelect').value = 'Hiburan';
    document.getElementById('dateInput').value = '2020-01-05';
    document.getElementById('noteInput').value = 'uji reset';
    document.getElementById('transactionForm').requestSubmit();
    return {
      amount: document.getElementById('amountInput').value,
      category: document.getElementById('categorySelect').value,
      date: document.getElementById('dateInput').value,
      note: document.getElementById('noteInput').value,
      errorsHidden: ['amountError', 'categoryError', 'dateError']
        .every(id => document.getElementById(id).hidden),
      invalidStyled: document.querySelectorAll('#transactionForm .is-invalid').length,
      type: document.getElementById('transactionForm').dataset.type,
      expensePressed: document.querySelector('[data-form-type="expense"]').getAttribute('aria-pressed')
    };
  `);
  check(
    'resetAddForm clears all fields',
    reset.amount === '' && reset.category === '' && reset.note === '',
    JSON.stringify(reset)
  );
  check('resetAddForm restores today date', reset.date === TODAY, `${reset.date} != ${TODAY}`);
  check(
    'resetAddForm clears validation state',
    reset.errorsHidden && reset.invalidStyled === 0,
    JSON.stringify(reset)
  );
  check(
    'resetAddForm keeps selected type',
    reset.type === 'expense' && reset.expensePressed === 'true',
    JSON.stringify(reset)
  );

  check('no runtime errors', errors.length === 0, errors.join(' | '));
} catch (error) {
  console.error('SMOKE ERROR:', error.stack || error.message);
  results.push({ name: 'smoke run', ok: false, detail: error.message });
} finally {
  if (socket) socket.close();
  if (chrome) chrome.kill();
  await sleep(500);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
