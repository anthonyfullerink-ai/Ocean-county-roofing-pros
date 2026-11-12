/**
 * Antigravity Control Plane JS Controller — Owner Command Center (/admin)
 * Connects the 3-Pane Obsidian UI to /api/admin/*, Supabase, Vapi, Resend & Twilio.
 */

const ADMIN_TOKEN_KEY = 'ocrp_owner_session_token';
const ADMIN_USER_KEY = 'ocrp_owner_session_user';
const LEFT_SIDEBAR_KEY = 'ocrp_left_sidebar_collapsed';
const RIGHT_PANE_WIDTH_KEY = 'ocrp_right_pane_width';

const OCEAN_MONMOUTH_TOWNS = [
    'Toms River', 'Brick', 'Lakewood', 'Jackson', 'Point Pleasant',
    'Manchester', 'Lacey', 'Barnegat', 'Manahawkin', 'Little Egg Harbor',
    'Beach Haven', 'Seaside Heights', 'Howell', 'Wall', 'Freehold'
];

const STATE = {
    leads: [],
    tenants: [],
    projects: [],
    reviews: [],
    gbp_posts: [],
    agent_runs: [],
    sys_settings: {},
    territory_routing: {},
    kpis: {},
    emails: { received: [], sent: [], activeFolder: 'inbound' },
    vapi: { sarah: null, riley: null, calls: [] },
    selectedLeadId: null,
    selectedEmailId: null,
    selectedCallId: null
};

function showToast(msg, isError = false) {
    const el = document.getElementById('toastBanner');
    if (!el) return;
    el.innerText = msg;
    el.className = `fixed bottom-5 right-5 z-50 px-4 py-2.5 rounded-xl shadow-2xl text-xs font-extrabold border transition-all ${
        isError
            ? 'bg-rose-950/95 text-rose-200 border-rose-500/50'
            : 'bg-teal-950/95 text-teal-200 border-teal-500/50'
    }`;
    el.classList.remove('hidden');
    clearTimeout(window.__toastTimer);
    window.__toastTimer = setTimeout(() => el.classList.add('hidden'), 3800);
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ============================================================================
// 1. AUTHENTICATION GATE (/api/admin/auth & /api/admin/auth/verify)
// ============================================================================
function unlockAdminDashboard(username) {
    const overlay = document.getElementById('adminLoginOverlay');
    const shell = document.getElementById('adminAppShell');
    const pill = document.getElementById('adminSessionPill');
    const userDisplay = document.getElementById('adminUserDisplay');
    if (overlay) overlay.classList.add('hidden');
    if (shell) shell.classList.remove('opacity-0', 'pointer-events-none');
    if (pill) {
        pill.classList.remove('hidden');
        pill.classList.add('flex');
    }
    if (userDisplay && username) userDisplay.innerText = username;
    hydrateAdminBootstrap();
    runLiveDiagnostics();
}

async function checkAdminSession() {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);
    const savedUser = localStorage.getItem(ADMIN_USER_KEY) || 'Admin';
    if (!token) return;
    try {
        const res = await fetch('/api/admin/auth/verify', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            const data = await res.json();
            if (data.authenticated) {
                unlockAdminDashboard(data.user || savedUser);
                return;
            }
        }
    } catch (err) {
        console.warn('Auth verification check failed:', err);
    }
    localStorage.removeItem(ADMIN_TOKEN_KEY);
}

async function handleAdminLogin(e) {
    e.preventDefault();
    const u = document.getElementById('loginUsername').value.trim();
    const p = document.getElementById('loginPassword').value.trim();
    const errEl = document.getElementById('loginErrorMsg');
    const btn = document.getElementById('loginSubmitBtn');
    if (errEl) errEl.classList.add('hidden');
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Verifying Credentials...';
    }
    try {
        const res = await fetch('/api/admin/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, password: p })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.authenticated) {
            localStorage.setItem(ADMIN_TOKEN_KEY, data.token);
            localStorage.setItem(ADMIN_USER_KEY, data.user || u);
            unlockAdminDashboard(data.user || u);
            showToast('Welcome to Owner Command Center');
        } else {
            if (errEl) {
                errEl.innerText = data.error || data.detail || 'Invalid username or password.';
                errEl.classList.remove('hidden');
            }
        }
    } catch (err) {
        if (errEl) {
            errEl.innerText = 'Network error connecting to authentication service.';
            errEl.classList.remove('hidden');
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = 'Sign In to Command Center';
        }
    }
}

function handleAdminLogout() {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    localStorage.removeItem(ADMIN_USER_KEY);
    window.location.reload();
}

// ============================================================================
// 2. 3-PANE WORKSPACE LAYOUT (LEFT RAIL, CENTER STAGE, RIGHT SPLIT-PANE)
// ============================================================================
const TAB_TITLES = {
    overview: 'Executive Overview & Partner ROI',
    crm: 'Leads & Master CRM Pipeline',
    emails: 'Email Center & Riley AI (@oceancountyroofingpros.com)',
    voice: 'Voice AI Studio — Sarah & Riley (Vapi Cloud)',
    sms: 'SMS & Alerts Center (Twilio)',
    tenants: 'Contractors & Hybrid Territory Routing',
    launchpad: 'SEO, GBP & 24h Photo Queue',
    website: 'Website & Live CRO Controls',
    agents: '5-Agent Autonomous Workforce & Health'
};

function switchTab(tabName) {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    document.querySelectorAll('.nav-rail-btn').forEach(b => {
        b.classList.remove('bg-[#1a1d26]', 'text-white', 'border-l-2', 'border-teal-400');
        b.classList.add('text-[#8b92a5]');
    });
    const panel = document.getElementById('tab-' + tabName);
    const btn = document.getElementById('tabBtn-' + tabName);
    if (panel) panel.classList.remove('hidden');
    if (btn) {
        btn.classList.add('bg-[#1a1d26]', 'text-white', 'border-l-2', 'border-teal-400');
        btn.classList.remove('text-[#8b92a5]');
    }
    const crumb = document.getElementById('activeBreadcrumbTitle');
    if (crumb) crumb.innerText = TAB_TITLES[tabName] || tabName;

    if (tabName === 'emails' && STATE.emails.received.length === 0) loadResendEmails('inbound');
    if (tabName === 'voice' && !STATE.vapi.sarah) loadVapiOverview();
    if (tabName === 'agents') runLiveDiagnostics();
}

function toggleLeftSidebar(forceCollapsed) {
    const sidebar = document.getElementById('leftSidebar');
    if (!sidebar) return;
    const isCollapsed = forceCollapsed !== undefined
        ? forceCollapsed
        : !sidebar.classList.contains('w-16');
    if (isCollapsed) {
        sidebar.classList.remove('w-60');
        sidebar.classList.add('w-16');
        document.querySelectorAll('.sidebar-text').forEach(el => el.classList.add('hidden'));
    } else {
        sidebar.classList.remove('w-16');
        sidebar.classList.add('w-60');
        document.querySelectorAll('.sidebar-text').forEach(el => el.classList.remove('hidden'));
    }
    localStorage.setItem(LEFT_SIDEBAR_KEY, isCollapsed ? '1' : '0');
}

function toggleRightPane(forceOpen) {
    const pane = document.getElementById('rightSplitPane');
    const resizer = document.getElementById('rightPaneResizer');
    if (!pane) return;
    const shouldOpen = forceOpen !== undefined ? forceOpen : pane.classList.contains('hidden');
    if (shouldOpen) {
        pane.classList.remove('hidden');
        pane.classList.add('flex');
        if (resizer) resizer.classList.remove('hidden');
    } else {
        pane.classList.add('hidden');
        pane.classList.remove('flex');
        if (resizer) resizer.classList.add('hidden');
    }
}

function switchRightTab(mode) {
    toggleRightPane(true);
    ['inspector', 'preview', 'sandbox'].forEach(m => {
        const panel = document.getElementById('rightTab-' + m);
        const btn = document.getElementById('rightModeBtn-' + m);
        const headerBtn = document.getElementById('headerRightBtn-' + m);
        if (panel) panel.classList.toggle('hidden', m !== mode);
        if (btn) {
            btn.className = m === mode
                ? 'px-3 py-1.5 rounded-lg text-xs font-bold bg-teal-500/20 text-teal-300 border border-teal-500/30'
                : 'px-3 py-1.5 rounded-lg text-xs font-bold text-[#8b92a5] hover:text-white';
        }
        if (headerBtn) {
            headerBtn.className = m === mode
                ? 'px-2.5 py-1 rounded-lg text-[11px] font-bold bg-teal-500/20 text-teal-300 border border-teal-500/30'
                : 'px-2.5 py-1 rounded-lg text-[11px] font-bold bg-[#14161c] text-[#8b92a5] hover:text-white border border-[#1f222a]';
        }
    });
    if (mode === 'preview') {
        const iframe = document.getElementById('livePreviewIframe');
        if (iframe && (!iframe.getAttribute('src') || iframe.getAttribute('src') === 'about:blank')) {
            iframe.src = document.getElementById('previewUrlSelect')?.value || '/';
        }
    }
}

function initRightPaneResizer() {
    const resizer = document.getElementById('rightPaneResizer');
    const pane = document.getElementById('rightSplitPane');
    if (!resizer || !pane) return;
    const savedW = parseInt(localStorage.getItem(RIGHT_PANE_WIDTH_KEY) || '460', 10);
    if (savedW >= 340 && savedW <= 760) pane.style.width = `${savedW}px`;

    let dragging = false;
    resizer.addEventListener('mousedown', (e) => {
        dragging = true;
        document.body.style.cursor = 'col-resize';
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const newWidth = Math.min(760, Math.max(340, window.innerWidth - e.clientX));
        pane.style.width = `${newWidth}px`;
        localStorage.setItem(RIGHT_PANE_WIDTH_KEY, String(newWidth));
    });
    window.addEventListener('mouseup', () => {
        if (dragging) {
            dragging = false;
            document.body.style.cursor = '';
        }
    });
}

// ============================================================================
// 3. LIVE CLOUD BOOTSTRAP (/api/admin/bootstrap)
// ============================================================================
async function hydrateAdminBootstrap() {
    try {
        const res = await fetch('/api/admin/bootstrap');
        if (!res.ok) return;
        const data = await res.json();
        if (data.status !== 'success') return;

        STATE.leads = data.leads || [];
        STATE.tenants = data.tenants || [];
        STATE.projects = data.projects || [];
        STATE.reviews = data.reviews || [];
        STATE.gbp_posts = data.gbp_posts || [];
        STATE.agent_runs = data.agent_runs || [];
        STATE.sys_settings = data.sys_settings || {};
        STATE.territory_routing = data.territory_routing || {};
        STATE.kpis = data.kpis || {};

        updateKpiCards(STATE.kpis);
        renderRoiScoreboard(STATE.tenants, STATE.leads);
        renderCrmLeadsTable();
        renderTenantsCards();
        renderTerritoryMatrix();
        hydrateSettingsInputs();
        if (data.latest_report?.markdown_content) {
            const briefEl = document.getElementById('executiveBriefingBox');
            if (briefEl) briefEl.innerText = data.latest_report.markdown_content;
        }
    } catch (e) {
        console.warn('Bootstrap hydration error:', e);
    }
}

function updateKpiCards(k) {
    if (!k) return;
    const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };
    setTxt('kpiTotalLeads', k.total_leads ?? 0);
    setTxt('kpiBookedCount', `${k.booked_count ?? 0} Booked Inspections`);
    setTxt('kpiPipelineVal', `$${Number(k.active_pipeline_value || 0).toLocaleString()}`);
    setTxt('kpiWonVal', `$${Number(k.won_revenue_value || 0).toLocaleString()}`);
    setTxt('kpiRoiMultiple', `${k.roi_multiple ?? 0}x ROI`);
    setTxt('kpiRetainerAmt', `$${Number(k.monthly_retainer || 1500).toLocaleString()}/mo Retainer`);
    setTxt('kpiApprovedProjects', k.approved_projects_count ?? 0);
    setTxt('kpiPendingProjects', `${k.pending_projects_count ?? 0} Pending 24h Queue`);
    setTxt('kpiAvgRating', `★ ${k.avg_rating ?? '5.0'}`);
    setTxt('kpiReviewsCount', `${k.total_reviews_count ?? 0} Verified Reviews`);
    setTxt('navLeadCountBadge', k.total_leads ?? STATE.leads.length);
    if (k.active_tenant?.company_name) {
        setTxt('headerActivePartnerName', k.active_tenant.company_name);
    }
}

function renderRoiScoreboard(tenants, leads) {
    const tbody = document.getElementById('roiScoreboardBody');
    if (!tbody || !Array.isArray(tenants) || tenants.length === 0) return;
    tbody.innerHTML = tenants.map(t => {
        const tLeads = leads.filter(l => l.assigned_tenant_id === t.tenant_id);
        const booked = tLeads.filter(l => ['Booked', 'Inspection Booked', 'Inspected', 'Job Won', 'Completed'].includes(l.status)).length;
        const won = tLeads.filter(l => ['Job Won', 'Completed'].includes(l.status)).length;
        const pipe = tLeads.reduce((a, l) => a + (parseFloat(l.estimated_value) || 12500), 0);
        const retainer = parseFloat(t.monthly_retainer) || 1500;
        const roi = retainer > 0 ? Math.round((pipe / retainer) * 10) / 10 : 0;
        return `<tr class="border-b border-[#1f222a] hover:bg-[#1a1d26]/60">
            <td class="p-3 font-bold text-white">${escapeHtml(t.company_name)} ${t.is_active ? '<span class="ml-1.5 text-[10px] bg-teal-500/20 text-teal-300 px-2 py-0.5 rounded-full">PRIMARY</span>' : ''}</td>
            <td class="p-3 text-slate-300">${tLeads.length}</td>
            <td class="p-3 text-teal-300 font-bold">${booked}</td>
            <td class="p-3 text-emerald-400 font-bold">${won}</td>
            <td class="p-3 text-emerald-300 font-mono">$${pipe.toLocaleString()}</td>
            <td class="p-3 text-slate-400 font-mono">$${retainer.toLocaleString()}/mo</td>
            <td class="p-3"><span class="bg-amber-500/20 text-amber-300 font-black px-2.5 py-1 rounded-lg">${roi}x</span></td>
        </tr>`;
    }).join('');
}

// ============================================================================
// 4. MASTER CRM TABLE & LEAD INSPECTOR DOSSIER
// ============================================================================
function renderCrmLeadsTable() {
    const tbody = document.getElementById('crmTableBody');
    if (!tbody || STATE.leads.length === 0) return;
    const statuses = ['New Lead', 'Inspection Booked', 'Booked', 'Inspected', 'Job Won', 'Completed', 'Emergency Priority', 'Lost'];
    tbody.innerHTML = STATE.leads.map(l => {
        const searchStr = `${l.id} ${l.first_name} ${l.last_name} ${l.phone} ${l.email || ''} ${l.city} ${l.status} ${l.assigned_tenant_id}`.toLowerCase();
        return `<tr class="crm-row hover:bg-[#1a1d26] transition cursor-pointer border-b border-[#1f222a]"
            data-search="${escapeHtml(searchStr)}"
            data-status="${escapeHtml(l.status || '')}"
            data-tenant="${escapeHtml(l.assigned_tenant_id || '')}"
            onclick="inspectLead('${escapeHtml(l.id)}', event)">
            <td class="p-3 align-top">
                <div class="font-mono font-bold text-teal-400">${escapeHtml(l.id)}</div>
                <div class="text-[10px] text-[#8b92a5]">${escapeHtml(l.lead_source || 'Direct')}</div>
                <div class="text-[10px] text-slate-500">${escapeHtml((l.created_at || '').slice(0, 16).replace('T', ' '))}</div>
            </td>
            <td class="p-3 align-top">
                <div class="font-bold text-white">${escapeHtml(l.first_name)} ${escapeHtml(l.last_name)}</div>
                <a href="tel:${escapeHtml(l.phone)}" onclick="event.stopPropagation()" class="text-teal-300 font-mono hover:underline">${escapeHtml(l.phone)}</a>
                ${l.email ? `<div class="text-[10px] text-[#8b92a5]">${escapeHtml(l.email)}</div>` : ''}
            </td>
            <td class="p-3 align-top">
                <div class="font-bold text-slate-200">📍 ${escapeHtml(l.city || 'Ocean County')}, ${escapeHtml(l.state || 'NJ')}</div>
                <div class="text-[11px] text-[#8b92a5]">${escapeHtml(l.service_requested || 'Roof Inspection')}</div>
                ${l.appointment_slot ? `<div class="text-[10px] text-amber-300 mt-0.5">🗓️ ${escapeHtml(l.appointment_slot)}</div>` : ''}
            </td>
            <td class="p-3 align-top" onclick="event.stopPropagation()">
                <select onchange="updateLeadInline('${escapeHtml(l.id)}', {status: this.value})" class="bg-[#0a0a0c] border border-[#1f222a] rounded-lg px-2 py-1.5 text-xs font-bold text-white">
                    ${statuses.map(st => `<option value="${st}" ${l.status === st ? 'selected' : ''}>${st}</option>`).join('')}
                </select>
            </td>
            <td class="p-3 align-top" onclick="event.stopPropagation()">
                <input type="number" value="${Math.round(parseFloat(l.estimated_value) || 12500)}" onchange="updateLeadInline('${escapeHtml(l.id)}', {estimated_value: this.value})" class="w-24 bg-[#0a0a0c] border border-[#1f222a] rounded-lg px-2 py-1.5 text-xs font-mono font-bold text-emerald-400">
            </td>
            <td class="p-3 align-top" onclick="event.stopPropagation()">
                <select onchange="updateLeadInline('${escapeHtml(l.id)}', {assigned_tenant_id: this.value})" class="bg-[#0a0a0c] border border-[#1f222a] rounded-lg px-2 py-1.5 text-xs text-slate-200">
                    ${STATE.tenants.map(t => `<option value="${escapeHtml(t.tenant_id)}" ${l.assigned_tenant_id === t.tenant_id ? 'selected' : ''}>${escapeHtml(t.company_name)}</option>`).join('')}
                </select>
            </td>
            <td class="p-3 align-top max-w-xs" onclick="event.stopPropagation()">
                <input type="text" value="${escapeHtml(l.notes || '')}" onchange="updateLeadInline('${escapeHtml(l.id)}', {notes: this.value})" class="w-full bg-[#0a0a0c] border border-[#1f222a] rounded-lg px-2 py-1 text-xs text-slate-300">
            </td>
            <td class="p-3 align-top space-y-1" onclick="event.stopPropagation()">
                <button onclick="inspectLead('${escapeHtml(l.id)}')" class="w-full text-[10px] bg-teal-500/20 hover:bg-teal-500/30 text-teal-300 border border-teal-500/30 font-bold px-2 py-1 rounded">Inspect ◨</button>
                <button onclick="deleteLeadRow('${escapeHtml(l.id)}')" class="w-full text-[10px] bg-rose-950/60 hover:bg-rose-800 text-rose-300 px-2 py-1 rounded">Delete</button>
            </td>
        </tr>`;
    }).join('');
}

function filterCrmTable() {
    const q = (document.getElementById('crmSearchInput')?.value || '').toLowerCase();
    const st = document.getElementById('crmStatusFilter')?.value || '';
    const tn = document.getElementById('crmTenantFilter')?.value || '';
    document.querySelectorAll('.crm-row').forEach(row => {
        const matchQ = !q || (row.getAttribute('data-search') || '').includes(q);
        const matchSt = !st || row.getAttribute('data-status') === st;
        const matchTn = !tn || row.getAttribute('data-tenant') === tn;
        row.style.display = (matchQ && matchSt && matchTn) ? '' : 'none';
    });
}

function inspectLead(leadId, ev) {
    if (ev && ['SELECT', 'INPUT', 'BUTTON', 'A'].includes(ev.target.tagName)) return;
    const lead = STATE.leads.find(l => l.id === leadId);
    if (!lead) return;
    STATE.selectedLeadId = leadId;
    switchRightTab('inspector');
    const box = document.getElementById('inspectorContent');
    if (!box) return;

    box.innerHTML = `
        <div class="space-y-4">
            <div class="flex items-start justify-between border-b border-[#1f222a] pb-3">
                <div>
                    <span class="text-[10px] font-mono font-bold uppercase px-2 py-0.5 rounded bg-teal-500/20 text-teal-300">${escapeHtml(lead.id)}</span>
                    <h3 class="text-base font-black text-white mt-1">${escapeHtml(lead.first_name)} ${escapeHtml(lead.last_name)}</h3>
                    <p class="text-xs text-[#8b92a5]">📍 ${escapeHtml(lead.street_address || '')} ${escapeHtml(lead.city || '')}, ${escapeHtml(lead.state || 'NJ')}</p>
                </div>
                <span class="text-[11px] font-bold px-2.5 py-1 rounded-full bg-[#1a1d26] text-teal-300 border border-[#1f222a]">${escapeHtml(lead.status)}</span>
            </div>

            <div class="grid grid-cols-2 gap-2 text-xs bg-[#0a0a0c] p-3 rounded-xl border border-[#1f222a]">
                <div><span class="text-[#8b92a5] block text-[10px]">Phone</span><a href="tel:${escapeHtml(lead.phone)}" class="font-mono font-bold text-teal-400">${escapeHtml(lead.phone)}</a></div>
                <div><span class="text-[#8b92a5] block text-[10px]">Email</span><span class="text-white break-all">${escapeHtml(lead.email || '—')}</span></div>
                <div><span class="text-[#8b92a5] block text-[10px]">Service</span><span class="text-white">${escapeHtml(lead.service_requested || 'Roof Inspection')}</span></div>
                <div><span class="text-[#8b92a5] block text-[10px]">Est. Value</span><span class="font-mono font-bold text-emerald-400">$${Number(lead.estimated_value || 12500).toLocaleString()}</span></div>
                <div class="col-span-2"><span class="text-[#8b92a5] block text-[10px]">Appointment Slot</span><span class="text-amber-300 font-bold">${escapeHtml(lead.appointment_slot || 'Unscheduled')}</span></div>
            </div>

            ${lead.call_recording_url ? `
            <div class="bg-[#0a0a0c] p-3 rounded-xl border border-[#1f222a] space-y-1.5">
                <div class="text-[10px] font-bold uppercase text-sky-400">🎧 Vapi Voice Recording</div>
                <audio controls src="${escapeHtml(lead.call_recording_url)}" class="w-full h-8"></audio>
            </div>` : ''}

            <div class="space-y-1.5">
                <label class="text-[10px] font-bold uppercase text-[#8b92a5]">CRM Dossier Notes & Timeline</label>
                <textarea id="inspLeadNotes" rows="4" class="w-full bg-[#0a0a0c] border border-[#1f222a] rounded-xl p-2.5 text-xs text-slate-200 font-mono">${escapeHtml(lead.notes || '')}</textarea>
                <button onclick="updateLeadInline('${escapeHtml(lead.id)}', {notes: document.getElementById('inspLeadNotes').value})" class="w-full bg-teal-600 hover:bg-teal-500 text-white font-bold text-xs py-2 rounded-xl">💾 Save Dossier Notes</button>
            </div>

            <div class="bg-[#0a0a0c] p-3 rounded-xl border border-[#1f222a] space-y-2">
                <div class="text-[10px] font-bold uppercase text-teal-400">💬 Instant SMS to ${escapeHtml(lead.first_name)}</div>
                <textarea id="inspQuickSms" rows="2" placeholder="Hi ${escapeHtml(lead.first_name)}, this is Riley from Ocean County Roofing Pros..." class="w-full bg-[#14161c] border border-[#1f222a] rounded-lg p-2 text-xs text-white"></textarea>
                <button onclick="sendQuickLeadSms('${escapeHtml(lead.id)}', '${escapeHtml(lead.phone)}')" class="w-full bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs py-1.5 rounded-lg">📲 Dispatch Twilio SMS</button>
            </div>
        </div>`;
}

async function sendQuickLeadSms(leadId, phone) {
    const body = document.getElementById('inspQuickSms')?.value?.trim();
    if (!body) return showToast('Enter an SMS message first', true);
    const res = await fetch('/api/admin/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: phone, body, lead_id: leadId })
    });
    const data = await res.json();
    if (res.ok) {
        showToast(`SMS (${data.status}) to ${phone}`);
        hydrateAdminBootstrap();
    } else {
        showToast(data.error || 'SMS failed', true);
    }
}

async function updateLeadInline(leadId, payload) {
    const res = await fetch(`/api/admin/leads/${encodeURIComponent(leadId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (res.ok) {
        const data = await res.json();
        const idx = STATE.leads.findIndex(l => l.id === leadId);
        if (idx >= 0 && data.lead) STATE.leads[idx] = { ...STATE.leads[idx], ...data.lead };
        showToast(`Saved ${leadId}${data.review_sms_result?.sent ? ' + Review SMS Sent!' : ''}`);
    } else {
        showToast('Failed updating lead', true);
    }
}

async function createManualLead(e) {
    e.preventDefault();
    const payload = {
        first_name: document.getElementById('nl_first').value,
        last_name: document.getElementById('nl_last').value,
        phone: document.getElementById('nl_phone').value,
        email: document.getElementById('nl_email')?.value || '',
        city: document.getElementById('nl_city').value,
        estimated_value: parseFloat(document.getElementById('nl_value').value || 12500),
        service_requested: 'Full Roof Replacement',
        status: 'New Lead'
    };
    const res = await fetch('/api/admin/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (res.ok) {
        showToast('Lead created in Supabase!');
        document.getElementById('newLeadModal')?.classList.add('hidden');
        await hydrateAdminBootstrap();
    } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.detail || 'Error creating lead', true);
    }
}

async function deleteLeadRow(leadId) {
    const res = await fetch(`/api/admin/leads/${encodeURIComponent(leadId)}`, { method: 'DELETE' });
    if (res.ok) {
        STATE.leads = STATE.leads.filter(l => l.id !== leadId);
        renderCrmLeadsTable();
        showToast(`Deleted ${leadId}`);
    }
}

async function handleCrmImport(e) {
    e.preventDefault();
    const fileInput = document.getElementById('crmImportFile');
    if (!fileInput?.files?.length) return;
    const formData = new FormData();
    formData.append('file', fileInput.files[0]);
    const res = await fetch('/api/crm/import', { method: 'POST', body: formData });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
        showToast(`Imported ${data.imported_count || 0} leads!`);
        hydrateAdminBootstrap();
    } else {
        showToast(data.error || 'Import failed', true);
    }
}

// ============================================================================
// 5. EMAIL CENTER & RILEY AI (/api/admin/emails, /send, /ai-draft)
// ============================================================================
async function loadResendEmails(folder = 'inbound') {
    STATE.emails.activeFolder = folder;
    const tbody = document.getElementById('emailListTableBody');
    if (tbody) tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-[#8b92a5]">Loading live Resend ${folder} emails...</td></tr>`;
    try {
        const res = await fetch(`/api/admin/emails?folder=${folder}`);
        const data = await res.json();
        STATE.emails.received = data.received || [];
        STATE.emails.sent = data.sent || [];
        renderEmailFolder(folder);
    } catch (e) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-rose-400">Error loading emails.</td></tr>`;
    }
}

function renderEmailFolder(folder) {
    STATE.emails.activeFolder = folder;
    const btnIn = document.getElementById('emailFolderBtn-inbound');
    const btnOut = document.getElementById('emailFolderBtn-sent');
    if (btnIn) btnIn.className = folder === 'inbound' ? 'px-3 py-1.5 rounded-lg text-xs font-bold bg-teal-500/20 text-teal-300 border border-teal-500/30' : 'px-3 py-1.5 rounded-lg text-xs font-bold text-[#8b92a5]';
    if (btnOut) btnOut.className = folder === 'sent' ? 'px-3 py-1.5 rounded-lg text-xs font-bold bg-teal-500/20 text-teal-300 border border-teal-500/30' : 'px-3 py-1.5 rounded-lg text-xs font-bold text-[#8b92a5]';

    const list = folder === 'inbound' ? STATE.emails.received : STATE.emails.sent;
    const direction = folder === 'inbound' ? 'received' : 'sent';
    const tbody = document.getElementById('emailListTableBody');
    if (!tbody) return;
    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-[#8b92a5]">No ${folder} emails returned by Resend API.</td></tr>`;
        return;
    }
    tbody.innerHTML = list.map(em => {
        const party = direction === 'received' ? (em.from || 'Unknown') : (Array.isArray(em.to) ? em.to.join(', ') : em.to || '');
        return `<tr onclick="inspectEmail('${escapeHtml(em.id)}', '${direction}')" class="hover:bg-[#1a1d26] cursor-pointer border-b border-[#1f222a]">
            <td class="p-3 font-mono text-xs text-teal-300">${escapeHtml(party)}</td>
            <td class="p-3 font-bold text-white text-xs">${escapeHtml(em.subject || '(No Subject)')}</td>
            <td class="p-3 text-[11px] text-[#8b92a5] font-mono">${escapeHtml((em.created_at || '').slice(0, 16).replace('T', ' '))}</td>
            <td class="p-3 text-right"><span class="text-[10px] bg-[#0a0a0c] border border-[#1f222a] px-2 py-1 rounded text-teal-300">Open Thread ◨</span></td>
        </tr>`;
    }).join('');
}

async function inspectEmail(emailId, direction = 'received') {
    switchRightTab('inspector');
    const box = document.getElementById('inspectorContent');
    if (box) box.innerHTML = `<div class="p-6 text-center text-xs text-[#8b92a5]">Fetching email ${escapeHtml(emailId)} from Resend...</div>`;
    const res = await fetch(`/api/admin/emails/${encodeURIComponent(emailId)}?direction=${direction}`);
    const data = await res.json();
    const em = data.email || {};
    const fromAddr = em.from || '';
    const bodyText = em.text || em.html || '(Empty body)';

    box.innerHTML = `
        <div class="space-y-4">
            <div class="border-b border-[#1f222a] pb-3">
                <span class="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-sky-500/20 text-sky-300">${escapeHtml(direction)}</span>
                <h3 class="text-sm font-black text-white mt-1">${escapeHtml(em.subject || '(No Subject)')}</h3>
                <div class="text-[11px] text-[#8b92a5] mt-1">From: <strong class="text-slate-200">${escapeHtml(fromAddr)}</strong></div>
                <div class="text-[11px] text-[#8b92a5]">To: <strong class="text-slate-200">${escapeHtml(Array.isArray(em.to) ? em.to.join(', ') : em.to || '')}</strong></div>
            </div>
            <div class="bg-[#0a0a0c] border border-[#1f222a] rounded-xl p-3 text-xs text-slate-200 whitespace-pre-wrap max-h-60 overflow-y-auto font-mono">${escapeHtml( em.text || bodyText.replace(/<[^>]+>/g, ' ') )}</div>
            <div class="space-y-2 pt-2 border-t border-[#1f222a]">
                <div class="flex items-center justify-between">
                    <label class="text-[10px] font-bold uppercase text-teal-400">Reply as Riley Davis (@oceancountyroofingpros.com)</label>
                    <button type="button" onclick="draftEmailReplyWithAi('${escapeHtml(fromAddr)}', '${escapeHtml(em.subject || '')}', \`${escapeHtml(em.text || '').replace(/`/g, '')}\`)" class="text-[11px] bg-purple-600/30 hover:bg-purple-600/50 text-purple-200 border border-purple-500/40 px-2.5 py-1 rounded-lg font-bold">✨ Ask Riley AI to Draft Reply</button>
                </div>
                <input type="text" id="inspReplyTo" value="${escapeHtml(fromAddr)}" class="w-full bg-[#0a0a0c] border border-[#1f222a] rounded-lg px-2.5 py-1.5 text-xs text-white">
                <input type="text" id="inspReplySubject" value="Re: ${escapeHtml(em.subject || 'Ocean County Roofing Pros')}" class="w-full bg-[#0a0a0c] border border-[#1f222a] rounded-lg px-2.5 py-1.5 text-xs text-white">
                <textarea id="inspReplyBody" rows="5" placeholder="Write or generate Riley AI reply..." class="w-full bg-[#0a0a0c] border border-[#1f222a] rounded-xl p-2.5 text-xs text-white"></textarea>
                <button onclick="sendInspectorEmailReply()" class="w-full bg-teal-600 hover:bg-teal-500 text-white font-extrabold text-xs py-2.5 rounded-xl">🚀 Send Branded Reply via Resend</button>
            </div>
        </div>`;
}

async function draftEmailReplyWithAi(senderEmail, subject, textBody) {
    showToast('Riley AI is drafting a reply...');
    const res = await fetch('/api/admin/emails/ai-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senderEmail, subject, textBody })
    });
    const data = await res.json();
    if (res.ok && data.analysis?.reply_body) {
        const area = document.getElementById('inspReplyBody');
        if (area) area.value = data.analysis.reply_body;
        showToast(`Drafted (${data.analysis.intent || 'Inquiry'})`);
    } else {
        showToast('Could not generate AI draft', true);
    }
}

async function sendInspectorEmailReply() {
    const to = document.getElementById('inspReplyTo')?.value?.trim();
    const subject = document.getElementById('inspReplySubject')?.value?.trim();
    const body = document.getElementById('inspReplyBody')?.value?.trim();
    if (!to || !body) return showToast('Recipient and body required', true);
    const res = await fetch('/api/admin/emails/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, body, from_persona: 'riley' })
    });
    if (res.ok) {
        showToast(`Email dispatched to ${to}!`);
        loadResendEmails('sent');
    } else {
        showToast('Failed to send email', true);
    }
}

async function sendManualEmail(e) {
    e.preventDefault();
    const payload = {
        from_persona: document.getElementById('em_from_persona').value,
        to: document.getElementById('em_to').value,
        subject: document.getElementById('em_subject').value,
        body: document.getElementById('em_body').value
    };
    const res = await fetch('/api/admin/emails/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (res.ok) {
        showToast(`Branded email sent to ${payload.to}!`);
        e.target.reset();
        loadResendEmails('sent');
    } else {
        showToast('Email dispatch failed', true);
    }
}

async function saveEmailAgentRules(e) {
    e.preventDefault();
    const rules = document.getElementById('email_agent_custom_rules').value;
    const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email_agent_custom_rules: rules })
    });
    if (res.ok) showToast('Riley Email AI rules saved to Supabase!');
}

// ============================================================================
// 6. VOICE AI STUDIO — SARAH & RILEY (/api/admin/vapi/overview & /assistant)
// ============================================================================
async function loadVapiOverview() {
    try {
        const res = await fetch('/api/admin/vapi/overview');
        const data = await res.json();
        if (!res.ok) return showToast(data.error || 'Vapi load error', true);
        STATE.vapi.sarah = data.sarah;
        STATE.vapi.riley = data.riley;
        STATE.vapi.calls = data.calls || [];

        if (data.sarah) {
            document.getElementById('vapi_sarah_first').value = data.sarah.firstMessage || '';
            document.getElementById('vapi_sarah_prompt').value = data.sarah.systemPrompt || '';
            document.getElementById('vapi_sarah_model').value = data.sarah.model || 'gpt-4o-mini';
            document.getElementById('vapi_sarah_temp').value = data.sarah.temperature ?? 0.4;
        }
        if (data.riley) {
            document.getElementById('vapi_riley_first').value = data.riley.firstMessage || '';
            document.getElementById('vapi_riley_prompt').value = data.riley.systemPrompt || '';
            document.getElementById('vapi_riley_model').value = data.riley.model || 'gpt-4o-mini';
            document.getElementById('vapi_riley_temp').value = data.riley.temperature ?? 0.4;
        }
        renderVapiCallsTable();
    } catch (e) {
        console.warn('Vapi load error:', e);
    }
}

function renderVapiCallsTable() {
    const tbody = document.getElementById('vapiCallsTableBody');
    if (!tbody) return;
    if (!STATE.vapi.calls.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-[#8b92a5]">No recent calls found on Vapi.</td></tr>`;
        return;
    }
    tbody.innerHTML = STATE.vapi.calls.map(c => `<tr onclick="inspectVapiCall('${escapeHtml(c.id)}')" class="hover:bg-[#1a1d26] cursor-pointer border-b border-[#1f222a]">
        <td class="p-3 font-bold text-teal-300 text-xs">${escapeHtml(c.assistantName)}</td>
        <td class="p-3 font-mono text-white text-xs">${escapeHtml(c.customerNumber)}</td>
        <td class="p-3 text-xs text-slate-300">${c.durationSeconds}s</td>
        <td class="p-3 text-xs text-[#8b92a5]">${escapeHtml(c.endedReason || c.status)}</td>
        <td class="p-3 text-xs text-slate-300 max-w-xs truncate">${escapeHtml(c.summary || 'Click to inspect transcript')}</td>
        <td class="p-3 text-right"><span class="text-[10px] bg-teal-500/20 text-teal-300 px-2 py-1 rounded font-bold">Play / Read ◨</span></td>
    </tr>`).join('');
}

function inspectVapiCall(callId) {
    const c = STATE.vapi.calls.find(x => x.id === callId);
    if (!c) return;
    switchRightTab('inspector');
    const box = document.getElementById('inspectorContent');
    box.innerHTML = `
        <div class="space-y-4">
            <div class="border-b border-[#1f222a] pb-3">
                <span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-purple-500/20 text-purple-300">${escapeHtml(c.assistantName)}</span>
                <h3 class="text-sm font-black text-white mt-1">Caller: ${escapeHtml(c.customerNumber)}</h3>
                <div class="text-[11px] text-[#8b92a5]">Duration: ${c.durationSeconds}s • ${escapeHtml((c.createdAt || '').slice(0, 19).replace('T', ' '))}</div>
            </div>
            ${c.recordingUrl ? `<audio controls src="${escapeHtml(c.recordingUrl)}" class="w-full"></audio>` : '<div class="text-xs text-[#8b92a5]">No audio recording URL attached.</div>'}
            <div class="bg-[#0a0a0c] border border-[#1f222a] rounded-xl p-3 space-y-1">
                <div class="text-[10px] font-bold uppercase text-teal-400">AI Call Summary</div>
                <p class="text-xs text-slate-200">${escapeHtml(c.summary || 'No summary generated.')}</p>
            </div>
            <div class="bg-[#0a0a0c] border border-[#1f222a] rounded-xl p-3 space-y-1">
                <div class="text-[10px] font-bold uppercase text-sky-400">Speaker Transcript</div>
                <pre class="text-xs text-slate-300 whitespace-pre-wrap font-mono max-h-80 overflow-y-auto">${escapeHtml(c.transcript || 'No transcript available.')}</pre>
            </div>
        </div>`;
}

async function pushVapiAssistant(key) {
    const payload = {
        assistantKey: key,
        firstMessage: document.getElementById(`vapi_${key}_first`).value,
        systemPrompt: document.getElementById(`vapi_${key}_prompt`).value,
        model: document.getElementById(`vapi_${key}_model`).value,
        temperature: parseFloat(document.getElementById(`vapi_${key}_temp`).value || 0.4)
    };
    showToast(`Pushing ${key.toUpperCase()} live to Vapi Cloud...`);
    const res = await fetch('/api/admin/vapi/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok) showToast(data.message || 'Updated on Vapi Cloud!');
    else showToast(data.error || 'Vapi update failed', true);
}

async function syncVapi(direction) {
    showToast(`Running Vapi ${direction.toUpperCase()} sync...`);
    const res = await fetch(`/api/vapi/sync/${direction}`, { method: 'POST' });
    if (res.ok) {
        showToast(`Vapi ${direction.toUpperCase()} sync complete!`);
        loadVapiOverview();
    } else {
        showToast('Vapi sync error', true);
    }
}

// ============================================================================
// 7. SMS & ALERTS + CONTRACTORS + TERRITORY ROUTING + WEBSITE CRO + SANDBOX
// ============================================================================
async function sendManualSms(e) {
    e.preventDefault();
    const to = document.getElementById('sms_to_phone').value.trim();
    const body = document.getElementById('sms_body_text').value.trim();
    const res = await fetch('/api/admin/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, body })
    });
    const data = await res.json();
    if (res.ok) {
        showToast(`SMS (${data.status}) to ${to}`);
        e.target.reset();
    } else showToast(data.error || 'SMS error', true);
}

async function saveSmsAlertSettings(e) {
    e.preventDefault();
    const payload = {
        owner_alert_phone: document.getElementById('set_owner_alert_phone').value,
        owner_alert_email: document.getElementById('set_owner_alert_email').value,
        alert_on_cold_lead: document.getElementById('set_alert_cold').checked ? 'true' : 'false',
        alert_on_booking: document.getElementById('set_alert_booking').checked ? 'true' : 'false',
        alert_on_emergency: document.getElementById('set_alert_emergency').checked ? 'true' : 'false',
        alert_daily_brief: document.getElementById('set_alert_brief').checked ? 'true' : 'false'
    };
    const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (res.ok) showToast('SMS & Alert routing saved!');
}

function renderTenantsCards() {
    const grid = document.getElementById('tenantsCardGrid');
    if (!grid || !STATE.tenants.length) return;
    grid.innerHTML = STATE.tenants.map(t => `
        <div class="bg-[#14161c] border-2 ${t.is_active ? 'border-teal-500' : 'border-[#1f222a]'} rounded-2xl p-5 space-y-3">
            <div class="flex justify-between items-start">
                <div>
                    <span class="text-[10px] font-black uppercase px-2.5 py-0.5 rounded-full ${t.is_active ? 'bg-teal-500/20 text-teal-300' : 'bg-[#0a0a0c] text-[#8b92a5]'}">${t.is_active ? '🟢 PRIMARY DEFAULT PARTNER' : '⚪ TERRITORY / STANDBY PARTNER'}</span>
                    <h4 class="text-lg font-black text-white mt-1">${escapeHtml(t.company_name)}</h4>
                    <p class="text-xs text-[#8b92a5]">ID: <code>${escapeHtml(t.tenant_id)}</code> • Estimator: <strong class="text-white">${escapeHtml(t.estimator_name)}</strong></p>
                </div>
                ${!t.is_active ? `<button onclick="switchActiveTenant('${escapeHtml(t.tenant_id)}')" class="bg-teal-600 hover:bg-teal-500 text-white text-xs font-extrabold px-3 py-1.5 rounded-xl">⚡ Set Primary</button>` : ''}
            </div>
            <div class="grid grid-cols-2 gap-2 text-xs bg-[#0a0a0c] p-3 rounded-xl border border-[#1f222a]">
                <div><span class="text-[#8b92a5] block text-[10px]">Dispatch Phone</span><strong class="text-white font-mono">${escapeHtml(t.dispatch_phone)}</strong></div>
                <div><span class="text-[#8b92a5] block text-[10px]">Partner Email</span><strong class="text-white">${escapeHtml(t.email || '—')}</strong></div>
                <div><span class="text-[#8b92a5] block text-[10px]">Monthly Retainer</span><strong class="text-emerald-400 font-mono">$${Number(t.monthly_retainer || 1500).toLocaleString()}/mo</strong></div>
                <div><span class="text-[#8b92a5] block text-[10px]">Portal PIN</span><strong class="text-amber-300 font-mono">${escapeHtml(t.portal_pin)}</strong></div>
            </div>
        </div>`).join('');
}

function renderTerritoryMatrix() {
    const container = document.getElementById('territoryMatrixGrid');
    if (!container) return;
    container.innerHTML = OCEAN_MONMOUTH_TOWNS.map(town => {
        const assigned = STATE.territory_routing[town] || 'DEFAULT';
        return `<div class="bg-[#0a0a0c] border border-[#1f222a] rounded-xl p-3 flex items-center justify-between gap-2">
            <span class="text-xs font-bold text-white">📍 ${escapeHtml(town)}</span>
            <select data-town="${escapeHtml(town)}" class="territory-town-select bg-[#14161c] border border-[#1f222a] rounded-lg px-2 py-1 text-xs text-teal-300 font-semibold">
                <option value="DEFAULT" ${assigned === 'DEFAULT' ? 'selected' : ''}>Primary Default Partner</option>
                ${STATE.tenants.map(t => `<option value="${escapeHtml(t.tenant_id)}" ${assigned === t.tenant_id ? 'selected' : ''}>${escapeHtml(t.company_name)}</option>`).join('')}
            </select>
        </div>`;
    }).join('');
}

async function saveTerritoryRouting(e) {
    if (e) e.preventDefault();
    const map = {};
    document.querySelectorAll('.territory-town-select').forEach(sel => {
        const town = sel.getAttribute('data-town');
        if (sel.value && sel.value !== 'DEFAULT') map[town] = sel.value;
    });
    const res = await fetch('/api/admin/routing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ territory_routing: map })
    });
    if (res.ok) {
        STATE.territory_routing = map;
        showToast('Hybrid Town Territory Routing saved to Supabase!');
    }
}

async function switchActiveTenant(tenantId) {
    const res = await fetch('/api/admin/tenants/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: tenantId })
    });
    if (res.ok) {
        showToast(`Switched Primary Default Partner to ${tenantId}`);
        hydrateAdminBootstrap();
    }
}

async function saveTenantPartner(e) {
    e.preventDefault();
    const payload = {
        company_name: document.getElementById('tp_name').value,
        estimator_name: document.getElementById('tp_estimator').value,
        dispatch_phone: document.getElementById('tp_phone').value,
        email: document.getElementById('tp_email').value,
        portal_pin: document.getElementById('tp_pin').value,
        scheduling_type: document.getElementById('tp_sched_type').value,
        booking_url: document.getElementById('tp_booking_url').value,
        monthly_retainer: parseFloat(document.getElementById('tp_retainer')?.value || 1500)
    };
    const res = await fetch('/api/admin/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (res.ok) {
        showToast(`Saved contractor partner ${payload.company_name}!`);
        hydrateAdminBootstrap();
    }
}

function hydrateSettingsInputs() {
    const s = STATE.sys_settings || {};
    const setVal = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined) el.value = v; };
    const setChk = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined) el.checked = String(v) === 'true'; };
    setVal('email_agent_custom_rules', s.email_agent_custom_rules || '');
    setVal('set_owner_alert_phone', s.owner_alert_phone || '+17326609121');
    setVal('set_owner_alert_email', s.owner_alert_email || 'info@oceancountyroofingpros.com');
    setChk('set_alert_cold', s.alert_on_cold_lead ?? 'true');
    setChk('set_alert_booking', s.alert_on_booking ?? 'true');
    setChk('set_alert_emergency', s.alert_on_emergency ?? 'true');
    setChk('set_alert_brief', s.alert_daily_brief ?? 'true');
    setChk('cro_emergency_banner_enabled', s.emergency_banner_enabled ?? 'false');
    setVal('cro_emergency_banner_text', s.emergency_banner_text || '⚡ OCEAN COUNTY STORM DISPATCH ACTIVE: Same-Day Roof Leak Triage & Tarping');
    setVal('cro_dispatch_phone_display', s.dispatch_phone_display || '(732) 660-9121');
    setVal('cro_ticker_messages_json', s.ticker_messages_json || '["Riley booked a roof inspection in Toms River (Silverton)", "Completed CertainTeed Landmark PRO install in Brick"]');
}

async function saveWebsiteCroSettings(e) {
    e.preventDefault();
    const tickerRaw = document.getElementById('cro_ticker_messages_json').value.trim();
    try {
        const parsed = JSON.parse(tickerRaw);
        if (!Array.isArray(parsed)) throw new Error('Ticker must be a JSON array');
    } catch (err) {
        return showToast('Invalid JSON array in Dispatch Activity Ticker Messages.', true);
    }
    const payload = {
        emergency_banner_enabled: document.getElementById('cro_emergency_banner_enabled').checked ? 'true' : 'false',
        emergency_banner_text: document.getElementById('cro_emergency_banner_text').value,
        dispatch_phone_display: document.getElementById('cro_dispatch_phone_display').value,
        ticker_messages_json: tickerRaw
    };
    const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (res.ok) {
        showToast('Website & CRO controls pushed live!');
        refreshPreviewFrame();
    } else {
        showToast('Failed to save CRO controls.', true);
    }
}

function previewWebsiteInRightPane(url = '/') {
    const sel = document.getElementById('previewUrlSelect');
    if (sel) sel.value = url;
    switchRightTab('preview');
    loadPreviewUrl(url);
}

function loadPreviewUrl(url) {
    const iframe = document.getElementById('livePreviewIframe');
    if (iframe) iframe.src = url;
}

function refreshPreviewFrame() {
    const iframe = document.getElementById('livePreviewIframe');
    if (iframe && iframe.src) iframe.src = iframe.src;
}

function setPreviewViewport(vp) {
    const iframe = document.getElementById('livePreviewIframe');
    if (!iframe) return;
    iframe.style.maxWidth = vp === 'mobile' ? '390px' : '100%';
}

async function handlePhotoUpload(e, role) {
    e.preventDefault();
    const formData = new FormData(e.target);
    formData.append('uploaded_by', role);
    const res = await fetch('/api/media/upload', { method: 'POST', body: formData });
    if (res.ok) {
        showToast('Geo-tagged WebP & JPG published!');
        hydrateAdminBootstrap();
    }
}

async function projectAction(id, action) {
    await fetch(`/api/admin/projects/${id}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
    showToast(`Project #${id} ${action}d`);
    hydrateAdminBootstrap();
}

async function gbpAction(id, action) {
    await fetch(`/api/admin/gbp/${id}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
    showToast(`GBP Post #${id} ${action}d`);
}

async function reviewAction(id, action) {
    const draft = document.getElementById('revReply-' + id)?.value || '';
    await fetch(`/api/admin/reviews/${id}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ai_reply_draft: draft }) });
    showToast(`Review #${id} reply published`);
}

function copyTextById(id) { navigator.clipboard.writeText(document.getElementById(id)?.innerText || ''); showToast('Copied to clipboard!'); }
function copyInputVal(id) { navigator.clipboard.writeText(document.getElementById(id)?.value || ''); showToast('Copied reply to clipboard!'); }

async function runAllAgentsNow() {
    showToast('Running all 5 Autonomous Agents...');
    const res = await fetch('/api/agents/run-all', { method: 'POST' });
    if (res.ok) { showToast('All 5 Agents completed!'); hydrateAdminBootstrap(); }
}

async function runSingleAgent(name) {
    showToast(`Running Agent: ${name}...`);
    const res = await fetch(`/api/agents/run/${name}`, { method: 'POST' });
    if (res.ok) { showToast(`Agent ${name} finished!`); hydrateAdminBootstrap(); }
}

async function saveKillSwitches(e) {
    e.preventDefault();
    const payload = {
        auto_publish_24h: document.getElementById('ks_auto_publish_24h').checked ? 'true' : 'false',
        enable_review_sms: document.getElementById('ks_enable_review_sms').checked ? 'true' : 'false',
        enable_weather_storm_banner: document.getElementById('ks_enable_weather_storm_banner').checked ? 'true' : 'false',
        enable_vapi_callback: document.getElementById('ks_enable_vapi_callback').checked ? 'true' : 'false',
        gbp_review_url: document.getElementById('ks_gbp_review_url').value,
        gbp_webhook_url: document.getElementById('ks_gbp_webhook_url').value,
        admin_pin: document.getElementById('ks_admin_pin').value
    };
    const res = await fetch('/api/admin/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (res.ok) showToast('Kill-Switches & Settings saved!');
}

async function runLiveDiagnostics() {
    try {
        const res = await fetch('/api/admin/diagnostics');
        const data = await res.json();
        if (!res.ok || !data.checks) return;
        ['supabase', 'vapi', 'resend', 'twilio'].forEach(svc => {
            const c = data.checks[svc] || {};
            const badge = document.querySelectorAll(`.diag-badge-${svc}`);
            badge.forEach(el => {
                el.innerText = c.status === 'online' ? '🟢 ONLINE' : (c.configured ? '🟡 CHECK' : '⚪ UNSET');
                el.className = `diag-badge-${svc} text-[10px] font-mono font-bold px-2 py-0.5 rounded ${c.status === 'online' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}`;
            });
        });
    } catch (e) { console.warn('Diagnostics check failed:', e); }
}

async function simulateRileyEmailTriage(e) {
    e.preventDefault();
    const payload = {
        senderEmail: document.getElementById('sbx_sender').value,
        subject: document.getElementById('sbx_subject').value,
        textBody: document.getElementById('sbx_body').value
    };
    const out = document.getElementById('sandboxResultBox');
    if (out) out.innerHTML = `<div class="text-xs text-teal-300 animate-pulse">Simulating Riley AI Triage...</div>`;
    const res = await fetch('/api/admin/sandbox/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok && out) {
        const a = data.analysis || {};
        out.innerHTML = `
            <div class="space-y-2 bg-[#0a0a0c] border border-[#1f222a] rounded-xl p-3 text-xs">
                <div class="flex justify-between"><span class="text-[#8b92a5]">Intent:</span><strong class="text-teal-300 uppercase">${escapeHtml(a.intent || 'general')}</strong></div>
                <div class="flex justify-between"><span class="text-[#8b92a5]">Routed Partner:</span><strong class="text-emerald-400">${escapeHtml(data.tenant?.company_name || 'Primary Default')}</strong></div>
                <div class="text-[#8b92a5] text-[10px] uppercase font-bold pt-1">Extracted Entities:</div>
                <pre class="text-[11px] font-mono text-sky-300 bg-[#14161c] p-2 rounded overflow-x-auto">${escapeHtml(JSON.stringify(a.extracted || {}, null, 2))}</pre>
                <div class="text-[#8b92a5] text-[10px] uppercase font-bold pt-1">Drafted Reply from Riley:</div>
                <div class="text-slate-200 bg-[#14161c] p-2.5 rounded whitespace-pre-wrap font-mono text-[11px]">${escapeHtml(a.reply_body || '')}</div>
            </div>`;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    if (localStorage.getItem(LEFT_SIDEBAR_KEY) === '1') toggleLeftSidebar(true);
    initRightPaneResizer();
    checkAdminSession();
});
