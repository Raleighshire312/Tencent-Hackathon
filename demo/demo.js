const request = document.querySelector('#request');
const result = document.querySelector('#result');
const audit = document.querySelector('#audit');

function addEvent(label, status) {
  const event = document.createElement('div');
  event.className = 'event';
  event.innerHTML = `<b>${label}</b><span class="chip">${status}</span>`;
  audit.prepend(event);
}

function parseTransfers(text) {
  const matches = [...text.matchAll(/\b(?:send|pay|transfer)\s+([a-z][a-z0-9 _'-]*?)\s+(?:s\$|\$|sgd\s*)\s*([0-9]+(?:\.[0-9]{1,2})?)/gi)];
  const minimum = text.match(/(?:leave|keep|at least)\s*(?:s\$|\$|sgd\s*)\s*([0-9]+(?:\.[0-9]{1,2})?)/i);
  return matches.map((match) => ({ recipient: match[1].trim(), amount: Number(match[2]), minimum: minimum ? Number(minimum[1]) : 0 }));
}

function runScenario(scenario) {
  audit.innerHTML = '';
  const transfers = parseTransfers(request.value);
  addEvent('Intent compiler', `${transfers.length} INTENT${transfers.length === 1 ? '' : 'S'} FOUND`);
  if (!transfers.length) { result.className = 'result bad'; result.textContent = 'Blocked: no explicit transfer intent found.'; addEvent('Semantic verifier', 'BLOCKED'); return; }
  if (scenario === 'attack') { result.className = 'result bad'; result.textContent = 'Blocked: untrusted invoice text attempted to change the recipient.\n\nThe original approval remains valid only for the exact transaction fingerprint.'; addEvent('Untrusted content', 'BLOCKED'); addEvent('Execution gateway', 'NO TRANSFER'); return; }
  if (scenario === 'tamper') { result.className = 'result warn'; result.textContent = 'Blocked: approval fingerprint mismatch.\n\nThe amount or recipient changed after user approval.'; addEvent('Approval binding', 'MISMATCH'); addEvent('Execution gateway', 'NO TRANSFER'); return; }
  const total = transfers.reduce((sum, transfer) => sum + transfer.amount, 0);
  if (transfers[0].minimum && 1500 - total < transfers[0].minimum) { result.className = 'result warn'; result.textContent = `Blocked: payments total S$${total.toFixed(2)} and would leave S$${(1500-total).toFixed(2)}.\n\nRequired minimum: S$${transfers[0].minimum.toFixed(2)}.`; addEvent('Deterministic validation', 'BLOCKED'); addEvent('Execution gateway', 'NO TRANSFER'); return; }
  result.className = 'result good'; result.textContent = `Approved preview: ${transfers.length} payment${transfers.length === 1 ? '' : 's'} totaling S$${total.toFixed(2)}.\n\nExecution is allowed only after explicit approval of this exact transaction bundle.`; addEvent('Semantic verifier', 'PASS'); addEvent('Approval binding', 'READY'); addEvent('Mock ledger', 'PREVIEW ONLY');
}

document.querySelectorAll('button[data-scenario]').forEach((button) => button.addEventListener('click', () => runScenario(button.dataset.scenario)));
