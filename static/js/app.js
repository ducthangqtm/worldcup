// --- GLOBAL APP STATE ---
let state = {
    currentUser: null, // { token, player_id, name }
    adminToken: null,
    data: null, // full API payload
    activeTab: 'dashboard',
    activeDashboardTab: 'upcoming',
    activeAdminTab: 'admin-matches-tab',
    countdownInterval: null
};

// --- INIT APP ---
document.addEventListener("DOMContentLoaded", () => {
    // Load sessions from localStorage
    const savedSession = localStorage.getItem("player_session");
    if (savedSession) {
        try {
            state.currentUser = JSON.parse(savedSession);
        } catch (e) {
            localStorage.removeItem("player_session");
        }
    }

    // Admin token ONLY comes from sessionStorage (expires when tab/browser closes)
    // Always clear localStorage to remove any stale tokens from old sessions
    localStorage.removeItem("admin_session");
    const savedAdminSession = sessionStorage.getItem("admin_session");
    if (savedAdminSession && savedAdminSession !== "null" && savedAdminSession !== "undefined") {
        state.adminToken = savedAdminSession;
    } else {
        state.adminToken = null;
        sessionStorage.removeItem("admin_session");
    }

    // Load initial data
    refreshData().then(() => {
        setupEventListeners();
        startCountdownTimer();
        
        // Poll for updates every 30 seconds to support real-time score/points sync
        setInterval(refreshData, 30000);
        
        if (state.currentUser) {
            showApp();
        } else {
            showLogin();
        }
    });
});

// --- API FETCH HELPERS ---
async function refreshData() {
    const headers = {};
    if (state.currentUser) {
        headers["X-Player-ID"] = state.currentUser.player_id;
        headers["Authorization"] = state.currentUser.token;
    }
    
    try {
        const response = await fetch("/api/data", { headers });
        if (!response.ok) {
            if (response.status === 401) {
                // Token expired/invalid
                logout();
            }
            throw new Error("Cannot fetch data");
        }
        state.data = await response.json();
        
        // Check if user needs to change PIN
        if (state.data.needs_pin_change) {
            document.getElementById("change-pin-modal").style.display = "flex";
        } else {
            document.getElementById("change-pin-modal").style.display = "none";
        }
        
        // Render UI based on new data
        if (state.currentUser) {
            renderHeader();
            renderDashboard();
            renderMatches();
            renderStandings();
            renderBracket();
            renderAdminControls();
        }
        
        return true;
    } catch (e) {
        console.error("Error refreshing data:", e);
        showToast("Lỗi kết nối máy chủ", "error");
        return false;
    }
}

// --- NAVIGATION & VIEWS ---
function showLogin() {
    document.getElementById("login-overlay").classList.remove("hidden");
    document.getElementById("app-container").classList.add("hidden");
}

function showApp() {
    document.getElementById("login-overlay").classList.add("hidden");
    document.getElementById("app-container").classList.remove("hidden");
    
    // Set default tab
    switchTab(state.activeTab);
}

function switchTab(tabId) {
    state.activeTab = tabId;
    
    // Update nav buttons
    document.querySelectorAll(".bottom-nav .nav-item").forEach(btn => {
        btn.classList.remove("active");
    });
    
    const activeNavBtn = document.getElementById(`nav-${tabId}`);
    if (activeNavBtn) activeNavBtn.classList.add("active");
    
    // Update content blocks
    document.querySelectorAll(".content-area .tab-content").forEach(content => {
        content.classList.add("hidden");
    });
    
    const activeContent = document.getElementById(`tab-${tabId}`);
    if (activeContent) activeContent.classList.remove("hidden");
}

function switchAdminTab(tabId) {
    state.activeAdminTab = tabId;
    
    // Update buttons
    document.querySelectorAll(".admin-tab-btn").forEach(btn => {
        btn.classList.remove("active");
        if (btn.dataset.adminTab === tabId) btn.classList.add("active");
    });
    
    // Update tabs
    document.querySelectorAll(".admin-tab-content").forEach(content => {
        content.classList.add("hidden");
    });
    
    const activeContent = document.getElementById(tabId);
    if (activeContent) activeContent.classList.remove("hidden");
}

function switchDashboardMatchTab(subTab) {
    state.activeDashboardTab = subTab;
    
    const btnUpcoming = document.getElementById("btn-match-upcoming");
    const btnHistory = document.getElementById("btn-match-history");
    
    if (subTab === "upcoming") {
        btnUpcoming.classList.add("active");
        btnHistory.classList.remove("active");
    } else {
        btnUpcoming.classList.remove("active");
        btnHistory.classList.add("active");
    }
    
    renderMatches();
}

// --- EVENT LISTENERS ---
function setupEventListeners() {
    // Tab switching
    document.getElementById("nav-dashboard").addEventListener("click", () => switchTab("dashboard"));
    document.getElementById("nav-matches").addEventListener("click", () => switchTab("matches"));
    document.getElementById("nav-standings").addEventListener("click", () => switchTab("standings"));
    document.getElementById("nav-rules").addEventListener("click", () => switchTab("rules"));
    
    // Dashboard Match Sub-tab switching
    document.getElementById("btn-match-upcoming").addEventListener("click", () => switchDashboardMatchTab("upcoming"));
    document.getElementById("btn-match-history").addEventListener("click", () => switchDashboardMatchTab("history"));
    
    // Standings Sub-tab switching
    document.getElementById("btn-sub-groups").addEventListener("click", () => switchSubStandingsTab("groups"));
    document.getElementById("btn-sub-bracket").addEventListener("click", () => switchSubStandingsTab("bracket"));
    
    // Login Form Submit
    document.getElementById("login-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const username = document.getElementById("login-username").value.trim();
        const pin = document.getElementById("login-pin").value;
        const errorDiv = document.getElementById("login-error");
        
        errorDiv.classList.add("hidden");
        
        try {
            const res = await fetch("/api/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username, pin })
            });
            
            const result = await res.json();
            if (!res.ok) {
                errorDiv.textContent = result.error || "Lỗi đăng nhập";
                errorDiv.classList.remove("hidden");
                return;
            }
            
            // Save Session
            state.currentUser = result;
            localStorage.setItem("player_session", JSON.stringify(result));
            
            // Reset input
            document.getElementById("login-pin").value = "";
            
            if (result.needs_pin_change) {
                document.getElementById("change-pin-modal").style.display = "flex";
                showToast("Đăng nhập thành công! Vui lòng đổi mã PIN mặc định.", "success");
            } else {
                showToast("Đăng nhập thành công!", "success");
                showApp();
                refreshData();
            }
        } catch (err) {
            errorDiv.textContent = "Không thể kết nối đến máy chủ";
            errorDiv.classList.remove("hidden");
        }
    });
    
    // Logout
    document.getElementById("btn-logout").addEventListener("click", () => {
        logout();
    });
    
    // Admin overlay triggers - always verify token with server before showing controls
    document.getElementById("btn-admin-trigger").addEventListener("click", async () => {
        document.getElementById("admin-overlay").style.display = "block";
        if (state.adminToken) {
            // Re-verify token with server to prevent stale/invalid tokens bypassing the gate
            try {
                const res = await fetch("/api/admin/verify-token", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": state.adminToken
                    }
                });
                if (res.ok) {
                    showAdminControlsSection();
                    renderAdminControls();
                } else {
                    // Token invalid/expired - clear and show gate
                    state.adminToken = null;
                    sessionStorage.removeItem("admin_session");
                    showAdminGate();
                }
            } catch (e) {
                // Network error - show gate to be safe
                state.adminToken = null;
                sessionStorage.removeItem("admin_session");
                showAdminGate();
            }
        } else {
            showAdminGate();
        }
    });
    
    document.getElementById("btn-admin-close").addEventListener("click", () => {
        document.getElementById("admin-overlay").style.display = "none";
    });
    
    // Admin Auth Form
    document.getElementById("admin-auth-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const pin = document.getElementById("admin-pin").value;
        const errorDiv = document.getElementById("admin-auth-error");
        errorDiv.classList.add("hidden");
        
        try {
            const res = await fetch("/api/admin/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pin })
            });
            const result = await res.json();
            if (!res.ok) {
                errorDiv.textContent = result.error || "Mã PIN Admin sai";
                errorDiv.classList.remove("hidden");
                return;
            }
            
            state.adminToken = result.token;
            sessionStorage.setItem("admin_session", result.token);
            localStorage.removeItem("admin_session");
            document.getElementById("admin-pin").value = "";
            
            showToast("Đăng nhập Admin thành công!", "success");
            showAdminControlsSection();
            renderAdminControls();
        } catch (err) {
            errorDiv.textContent = "Lỗi kết nối";
            errorDiv.classList.remove("hidden");
        }
    });
    
    // Admin Tab switching
    document.querySelectorAll(".admin-tab-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            switchAdminTab(e.target.dataset.adminTab);
        });
    });
    
    // Admin ESPN Sync Click
    document.getElementById("btn-espn-sync").addEventListener("click", async () => {
        const btn = document.getElementById("btn-espn-sync");
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang đồng bộ...';
        
        try {
            const res = await fetch("/api/admin/sync", {
                method: "POST",
                headers: { "Authorization": state.adminToken }
            });
            const result = await res.json();
            if (res.ok) {
                showToast("Đồng bộ thành công!", "success");
                refreshData();
            } else {
                showToast(result.error || "Lỗi đồng bộ", "error");
            }
        } catch (e) {
            showToast("Lỗi kết nối", "error");
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-rotate"></i> Đồng bộ ESPN';
        }
    });
    
    // Admin Add Player Form
    document.getElementById("admin-add-player-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = document.getElementById("new-player-name").value;
        try {
            const res = await fetch("/api/admin/player", {
                method: "POST",
                headers: { 
                    "Content-Type": "application/json",
                    "Authorization": state.adminToken
                },
                body: JSON.stringify({ action: "create", name })
            });
            const result = await res.json();
            if (res.ok) {
                showToast(`Đã thêm ${name}`, "success");
                document.getElementById("new-player-name").value = "";
                refreshData();
            } else {
                showToast(result.error || "Lỗi thêm nhân viên", "error");
            }
        } catch (e) {
            showToast("Lỗi kết nối", "error");
        }
    });
    
    // Admin Override Submit
    document.getElementById("btn-save-override").addEventListener("click", async () => {
        const match_id = document.getElementById("override-match-select").value;
        const player_id = document.getElementById("override-player-select").value;
        const selection = document.querySelector('input[name="override-choice"]:checked').value;
        const violated = document.getElementById("override-violation").checked;
        
        if (!match_id || !player_id) {
            showToast("Vui lòng chọn đầy đủ trận đấu và nhân viên", "error");
            return;
        }
        
        try {
            const res = await fetch("/api/admin/prediction-override", {
                method: "POST",
                headers: { 
                    "Content-Type": "application/json",
                    "Authorization": state.adminToken
                },
                body: JSON.stringify({ match_id, player_id, selection, violated })
            });
            const result = await res.json();
            if (res.ok) {
                showToast("Cập nhật dự đoán thành công!", "success");
                refreshData();
            } else {
                showToast(result.error || "Lỗi cập nhật", "error");
            }
        } catch (e) {
            showToast("Lỗi kết nối", "error");
        }
    });
    
    // Match Override Dropdown triggers to label buttons correctly
    document.getElementById("override-match-select").addEventListener("change", () => {
        updateAdminOverrideLabels();
    });



    
    // Change PIN Form Submit
    document.getElementById("change-pin-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const new_pin = document.getElementById("new-pin").value;
        const confirm_pin = document.getElementById("confirm-new-pin").value;
        const errorDiv = document.getElementById("change-pin-error");
        
        errorDiv.classList.add("hidden");
        
        if (new_pin !== confirm_pin) {
            errorDiv.textContent = "Xác nhận mã PIN không khớp!";
            errorDiv.classList.remove("hidden");
            return;
        }
        
        if (new_pin === "1234") {
            errorDiv.textContent = "Không được sử dụng mã PIN mặc định 1234!";
            errorDiv.classList.remove("hidden");
            return;
        }
        
        try {
            const res = await fetch("/api/change-pin", {
                method: "POST",
                headers: { 
                    "Content-Type": "application/json",
                    "X-Player-ID": state.currentUser.player_id,
                    "Authorization": state.currentUser.token
                },
                body: JSON.stringify({ new_pin })
            });
            
            const result = await res.json();
            if (!res.ok) {
                errorDiv.textContent = result.error || "Lỗi đổi mã PIN";
                errorDiv.classList.remove("hidden");
                return;
            }
            
            // Update token in state and session storage
            state.currentUser.token = result.token;
            localStorage.setItem("player_session", JSON.stringify(state.currentUser));
            
            // Clean inputs
            document.getElementById("new-pin").value = "";
            document.getElementById("confirm-new-pin").value = "";
            
            // Hide modal
            document.getElementById("change-pin-modal").style.display = "none";
            showToast("Đổi mã PIN thành công!", "success");
            
            showApp();
            refreshData();
        } catch (err) {
            errorDiv.textContent = "Lỗi kết nối máy chủ";
            errorDiv.classList.remove("hidden");
        }
    });
}

// --- LOGOUT ---
function logout() {
    state.currentUser = null;
    state.adminToken = null;
    localStorage.removeItem("player_session");
    localStorage.removeItem("admin_session");
    sessionStorage.removeItem("admin_session");
    showToast("Đã đăng xuất", "success");
    showLogin();
    refreshData();
}

// --- SHOW ADMIN SUB-SECTIONS ---
function showAdminGate() {
    document.getElementById("admin-gate").classList.remove("hidden");
    document.getElementById("admin-controls").classList.add("hidden");
}

function showAdminControlsSection() {
    document.getElementById("admin-gate").classList.add("hidden");
    document.getElementById("admin-controls").classList.remove("hidden");
    switchAdminTab(state.activeAdminTab);
}

// --- TOAST SYSTEM ---
function showToast(message, type = "success") {
    const container = document.getElementById("toast-container");
    if (!container) return;
    
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    
    let icon = '<i class="fa-solid fa-circle-check"></i>';
    if (type === "error") {
        icon = '<i class="fa-solid fa-triangle-exclamation"></i>';
    }
    
    toast.innerHTML = `${icon} <span>${message}</span>`;
    container.appendChild(toast);
    
    // Remove toast after 3.5 seconds
    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateX(50px)";
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

// --- FORMAT VND ---
function formatVND(value) {
    return new Intl.NumberFormat('en-US').format(value) + ' pts';
}

// --- RENDER HEADER STATS ---
function renderHeader() {
    if (!state.data) return;
    
    document.getElementById("player-display-name").textContent = state.currentUser ? state.currentUser.name : "Người chơi";
    document.getElementById("total-fund-display").textContent = formatVND(state.data.total_fund);
    
    const finishedMatchesCount = state.data.matches.filter(m => m.finished).length;
    const totalMatchesCount = state.data.matches.length;
    document.getElementById("finished-matches-display").textContent = `${finishedMatchesCount} / ${totalMatchesCount}`;
}

// --- RENDER DASHBOARD (TAB 1) ---
function renderDashboard() {
    if (!state.data) return;
    
    // 1. Leaderboard
    const tbodyRank = document.getElementById("leaderboard-body-rank");
    if (tbodyRank) tbodyRank.innerHTML = "";
    
    // Leaderboard sorting:
    // 1. Expected contribution descending (highest penalty points first)
    // 2. Correct predictions descending
    // 3. Name alphabetically
    const sortedLeaderboard = [...state.data.leaderboard].sort((a, b) => {
        if (b.total_contribution !== a.total_contribution) {
            return b.total_contribution - a.total_contribution;
        }
        if (b.correct !== a.correct) {
            return b.correct - a.correct;
        }
        return a.name.localeCompare(b.name, 'vi');
    });
    
    sortedLeaderboard.forEach((p, idx) => {
        const tr = document.createElement("tr");
        if (state.currentUser && p.id === state.currentUser.player_id) {
            tr.className = "my-row";
        }
        
        let rankHtml = `<span class="rank-badge">${idx + 1}</span>`;
        if (idx === 0) rankHtml = `<span class="rank-badge rank-1"><i class="fa-solid fa-crown"></i></span>`;
        else if (idx === 1) rankHtml = `<span class="rank-badge rank-2">2</span>`;
        else if (idx === 2) rankHtml = `<span class="rank-badge rank-3">3</span>`;
        
        const isMeTag = (state.currentUser && p.id === state.currentUser.player_id) ? '<span class="me-tag">Bạn</span>' : '';
        
        tr.innerHTML = `
            <td class="text-center">${rankHtml}</td>
            <td class="player-name-cell">${p.name}${isMeTag}</td>
            <td class="text-center font-weight-500">${p.total_predicted}</td>
            <td class="text-center text-green font-weight-600">${p.correct}</td>
            <td class="text-center text-purple font-weight-600">${p.half_loss}</td>
            <td class="text-center text-danger font-weight-600">${p.full_loss}</td>
            <td class="text-right table-fund-value">${formatVND(p.total_contribution)}</td>
        `;
        if (tbodyRank) tbodyRank.appendChild(tr);
    });
    
    // 2. Upcoming matches quick view (max 3)
    const upcomingContainer = document.getElementById("upcoming-matches-container");
    upcomingContainer.innerHTML = "";
    
    const unlockedMatches = state.data.matches.filter(m => !m.locked).slice(0, 3);
    
    if (unlockedMatches.length === 0) {
        upcomingContainer.innerHTML = '<div class="text-center text-muted font-size-0.9 padding-10">Không có trận đấu nào sắp diễn ra hoặc tất cả các trận đấu đã đóng cổng bình chọn.</div>';
        return;
    }
    
    unlockedMatches.forEach(m => {
        const card = document.createElement("div");
        card.className = "quick-match-card";
        
        const localTimeStr = formatKickoffTime(m.kickoff);
        
        // Find current user's prediction for this match
        const myPred = state.data.predictions.find(p => p.match_id === m.id && p.player_id === state.currentUser.player_id);
        let myChoiceText = '<span class="text-danger font-size-0.8"><i class="fa-solid fa-triangle-exclamation"></i> Chưa dự đoán</span>';
        if (myPred && myPred.selection !== "none") {
            let choiceVal = "";
            if (myPred.selection === "teamA") choiceVal = m.teamA;
            else if (myPred.selection === "teamB") choiceVal = m.teamB;
            else choiceVal = "Hòa";
            myChoiceText = `<span class="text-green font-size-0.8"><i class="fa-solid fa-circle-check"></i> Đã chọn: <strong>${choiceVal}</strong></span>`;
        }
        
        card.innerHTML = `
            <div class="quick-match-teams">
                <img src="${m.teamA_logo}" onerror="this.src='/static/images/wc_trophy_bg.png'" alt="${m.teamA}">
                <span>${m.teamA}</span>
                <span class="text-muted">vs</span>
                <span>${m.teamB}</span>
                <img src="${m.teamB_logo}" onerror="this.src='/static/images/wc_trophy_bg.png'" alt="${m.teamB}">
            </div>
            <div class="quick-match-info">
                <span class="quick-match-time">${localTimeStr}</span>
                ${myChoiceText}
            </div>
        `;
        
        // Quick vote navigation on click
        card.style.cursor = "pointer";
        card.addEventListener("click", () => {
            switchTab("dashboard");
            switchDashboardMatchTab("upcoming");
            // Scroll to the specific match card
            setTimeout(() => {
                const matchEl = document.getElementById(m.id);
                if (matchEl) {
                    matchEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    // Flash the card border
                    matchEl.style.borderColor = "var(--purple)";
                    setTimeout(() => matchEl.style.borderColor = "var(--card-border)", 1500);
                }
            }, 100);
        });
        
        upcomingContainer.appendChild(card);
    });
}

// --- RENDER MATCHES (TAB 2) ---
function renderMatches() {
    if (!state.data) return;
    
    const container = document.getElementById("matches-list-container");
    container.innerHTML = "";
    
    // Filter matches based on active dashboard sub-tab
    let filteredMatches = [];
    if (state.activeDashboardTab === "upcoming") {
        filteredMatches = state.data.matches.filter(m => !m.finished);
        // Sort upcoming matches chronologically (earliest first)
        filteredMatches.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
    } else {
        filteredMatches = state.data.matches.filter(m => m.finished);
        // Sort history matches reverse-chronologically (latest first)
        filteredMatches.sort((a, b) => new Date(b.kickoff) - new Date(a.kickoff));
    }
    
    if (filteredMatches.length === 0) {
        const message = state.activeDashboardTab === "upcoming" 
            ? "Không có trận đấu nào đang hoặc sắp diễn ra." 
            : "Chưa có trận đấu nào kết thúc.";
        container.innerHTML = `<div class="card glass-card padding-30 text-center text-muted">${message}</div>`;
        return;
    }
    
    filteredMatches.forEach(m => {
        const card = document.createElement("div");
        card.id = m.id;
        card.className = "match-card glass-card animate-fade-in";
        
        // Badge style
        let badgeClass = "badge-cyan";
        if (m.stage === "round-of-32") badgeClass = "badge-purple";
        else if (m.stage === "round-of-16") badgeClass = "badge-purple border-gold";
        else if (m.stage === "quarterfinals") badgeClass = "badge-gold";
        else if (m.stage === "semifinals" || m.stage === "3rd-place-match") badgeClass = "badge-gold purple-glow";
        else if (m.stage === "final") badgeClass = "badge-danger gold-glow animate-pulse";
        
        // Lock badge
        let lockBadge = "";
        if (m.finished) {
            lockBadge = '<span class="badge badge-green"><i class="fa-solid fa-circle-check"></i> Đã kết thúc</span>';
        } else if (m.locked) {
            lockBadge = '<span class="badge badge-danger"><i class="fa-solid fa-lock"></i> Đã khóa bình chọn</span>';
        } else {
            lockBadge = `<span class="match-countdown" data-kickoff="${m.kickoff}">Đang tính giờ...</span>`;
        }
        
        // Score display or vs text
        let scoreHtml = `<span class="vs-text">VS</span>`;
        if (m.finished) {
            scoreHtml = `
                <div class="score-display">
                    <span class="${m.scoreA > m.scoreB ? 'text-gold' : ''}">${m.scoreA}</span>
                    <span class="score-divider">-</span>
                    <span class="${m.scoreB > m.scoreA ? 'text-gold' : ''}">${m.scoreB}</span>
                </div>
            `;
        }
        
        // Local formatted time
        const localTimeStr = formatKickoffTime(m.kickoff);
        
        // Selected values
        const myPred = state.data.predictions.find(p => p.match_id === m.id && p.player_id === state.currentUser.player_id);
        const selectedSelection = myPred ? myPred.selection : "none";
        
        const isTeamAActive = selectedSelection === "teamA" ? (m.locked ? "active-teamA locked" : "active-teamA") : (m.locked ? "locked" : "");
        const isDrawActive = selectedSelection === "draw" ? (m.locked ? "active-draw locked" : "active-draw") : (m.locked ? "locked" : "");
        const isTeamBActive = selectedSelection === "teamB" ? (m.locked ? "active-teamB locked" : "active-teamB") : (m.locked ? "locked" : "");
        const isDisabled = m.locked ? "disabled" : "";
        
        // Accordion states: we track which matches are open in DOM using class lists
        const existingCard = document.getElementById(m.id);
        const isOpen = existingCard && existingCard.querySelector(".breakdown-toggle").classList.contains("active");
        
        card.innerHTML = `
            <div class="match-card-header">
                <div class="match-badge-group">
                    <span class="badge ${badgeClass}">${m.stage_vn}</span>
                    <span class="badge badge-cyan">${formatVND(m.price)}</span>
                </div>
                <div class="match-lock-status">
                    ${lockBadge}
                </div>
            </div>
            
            <div class="match-card-body">
                <div class="match-vs-container">
                    <div class="match-team">
                        <img class="match-team-flag" src="${m.teamA_logo}" onerror="this.src='/static/images/wc_trophy_bg.png'" alt="${m.teamA}">
                        <span class="match-team-name">${m.teamA}</span>
                    </div>
                    
                    <div class="match-score-center">
                        ${scoreHtml}
                        <span class="match-time-label">${localTimeStr}</span>
                    </div>
                    
                    <div class="match-team">
                        <img class="match-team-flag" src="${m.teamB_logo}" onerror="this.src='/static/images/wc_trophy_bg.png'" alt="${m.teamB}">
                        <span class="match-team-name">${m.teamB}</span>
                    </div>
                </div>
                
                <!-- Prediction Panel -->
                <div class="prediction-section">
                    <div class="prediction-buttons-container">
                        <button class="btn-predict ${isTeamAActive}" ${isDisabled} onclick="submitPrediction('${m.id}', 'teamA')">
                            <i class="fa-solid fa-futbol"></i>
                            <span>Chọn ${m.teamA}</span>
                        </button>
                        <button class="btn-predict ${isDrawActive}" ${isDisabled} onclick="submitPrediction('${m.id}', 'draw')">
                            <i class="fa-solid fa-handshake"></i>
                            <span>Chọn Hòa</span>
                        </button>
                        <button class="btn-predict ${isTeamBActive}" ${isDisabled} onclick="submitPrediction('${m.id}', 'teamB')">
                            <i class="fa-solid fa-futbol"></i>
                            <span>Chọn ${m.teamB}</span>
                        </button>
                    </div>
                    
                    <!-- Accordion Toggle -->
                    <button class="breakdown-toggle ${isOpen ? 'active' : ''}" onclick="toggleBreakdown('${m.id}')">
                        <span>Xem bình chọn (${calculateMatchVotePercentage(m.id)}%)</span> <i class="fa-solid fa-chevron-down"></i>
                    </button>
                    
                    <!-- Accordion Content -->
                    <div class="breakdown-content ${isOpen ? '' : 'hidden'}" id="breakdown-${m.id}">
                        ${renderPredictionBreakdown(m)}
                    </div>
                </div>
            </div>
        `;
        
        container.appendChild(card);
    });
}

// --- SUBMIT PREDICTION ---
async function submitPrediction(matchId, selection) {
    if (!state.currentUser) {
        showToast("Vui lòng đăng nhập để bình chọn", "error");
        return;
    }
    
    // Find current active selection
    const myPred = state.data.predictions.find(p => p.match_id === matchId && p.player_id === state.currentUser.player_id);
    const currentSelection = myPred ? myPred.selection : "none";
    
    // Toggle: if click the same active selection, we deselect it (set to 'none')
    const finalSelection = currentSelection === selection ? "none" : selection;
    
    try {
        const res = await fetch("/api/predict", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Player-ID": state.currentUser.player_id,
                "Authorization": state.currentUser.token
            },
            body: JSON.stringify({ match_id: matchId, selection: finalSelection })
        });
        
        const result = await res.json();
        if (res.ok) {
            showToast(result.message || "Bình chọn thành công!", "success");
            refreshData();
        } else {
            showToast(result.error || "Lỗi bình chọn", "error");
        }
    } catch (e) {
        showToast("Lỗi kết nối máy chủ", "error");
    }
}

// --- ACCORDION BREAKDOWN CONTROLS ---
function toggleBreakdown(matchId) {
    const btn = document.querySelector(`#${matchId} .breakdown-toggle`);
    const content = document.getElementById(`breakdown-${matchId}`);
    
    if (content.classList.contains("hidden")) {
        content.classList.remove("hidden");
        btn.classList.add("active");
    } else {
        content.classList.add("hidden");
        btn.classList.remove("active");
    }
}

function calculateMatchVotePercentage(matchId) {
    if (!state.data) return 0;
    const matchPredictions = state.data.predictions.filter(p => p.match_id === matchId && p.selection !== "none");
    const totalPlayers = state.data.players.length;
    if (totalPlayers === 0) return 0;
    return Math.round((matchPredictions.length / totalPlayers) * 100);
}

function renderPredictionBreakdown(match) {
    const matchPredictions = state.data.predictions.filter(p => p.match_id === match.id);
    const totalPlayers = state.data.players.length;
    
    let cntA = 0, cntDraw = 0, cntB = 0;
    
    matchPredictions.forEach(p => {
        if (p.selection === "teamA") cntA++;
        else if (p.selection === "draw") cntDraw++;
        else if (p.selection === "teamB" || p.selection === "hidden") {
            // Wait, hidden predictions are team A/B or draw.
            // But since they are hidden to standard users, they count as "hidden" in selection value.
            // For simple stats, we aggregate what we know, or ESPN sync will reveal.
            // Let's check: if we have the actual selection, count it. If the selection is "hidden", we don't know the exact choice yet.
            // In case of "hidden", we just show it has been voted without adding to A, B, or Draw totals to avoid leaking!
            // Wait! If the user is logged in, and we return "hidden" for others' votes, how do we show distributions?
            // To prevent leaking, the distribution bars should also be hidden or set to 0/hidden until locked!
            // That's correct! If the match is not locked, we should NOT show the distribution percentage either, because someone could do math to guess!
            // E.g., if there is 1 vote and it is 100% Team A, you know what they voted!
            // So, if the match is NOT locked, we show: "Bình chọn đang ẩn cho đến khi khóa trận đấu".
            // If locked, we show the actual distribution.
        }
    });
    
    // Let's recalculate based on *actual* selections returned in data.
    // If the match is NOT locked, the backend hides other player's choices (value is "hidden").
    // So the UI won't know the breakdown details either, which is perfect and secure!
    
    // Count exact known selections:
    const knownPreds = matchPredictions.filter(p => p.selection && p.selection !== "hidden" && p.selection !== "none");
    knownPreds.forEach(p => {
        if (p.selection === "teamA") cntA++;
        else if (p.selection === "draw") cntDraw++;
        else if (p.selection === "teamB") cntB++;
    });
    
    const totalKnown = cntA + cntDraw + cntB;
    const pctA = totalKnown > 0 ? Math.round((cntA / totalKnown) * 100) : 0;
    const pctDraw = totalKnown > 0 ? Math.round((cntDraw / totalKnown) * 100) : 0;
    const pctB = totalKnown > 0 ? Math.round((cntB / totalKnown) * 100) : 0;
    
    // Distribution display
    let distributionHtml = "";
    if (match.locked || totalKnown > 0) {
        distributionHtml = `
            <div class="prediction-distribution">
                <div class="dist-bar teamA" style="width: ${pctA}%" title="${pctA}% chọn ${match.teamA}"></div>
                <div class="dist-bar draw" style="width: ${pctDraw}%" title="${pctDraw}% chọn Hòa"></div>
                <div class="dist-bar teamB" style="width: ${pctB}%" title="${pctB}% chọn ${match.teamB}"></div>
            </div>
            <div class="dist-legend">
                <span><span class="dist-legend-dot teamA"></span> ${match.teamA}: <strong>${pctA}%</strong></span>
                <span><span class="dist-legend-dot draw"></span> Hòa: <strong>${pctDraw}%</strong></span>
                <span><span class="dist-legend-dot teamB"></span> ${match.teamB}: <strong>${pctB}%</strong></span>
            </div>
        `;
    } else {
        distributionHtml = `
            <div class="info-note text-center" style="margin-bottom: 12px; font-size: 0.75rem;">
                <i class="fa-solid fa-eye-slash"></i> Tỷ lệ bình chọn chi tiết sẽ được công khai sau khi trận đấu khóa (22h ngày hôm trước).
            </div>
        `;
    }
    
    // Players choices list
    let playersListHtml = "";
    
    // Filter to only show active players
    const activePlayers = state.data.players.filter(p => p.is_active);
    
    // Map players to their predictions
    const playerPicks = activePlayers.map(p => {
        const pred = matchPredictions.find(pr => pr.player_id === p.id);
        return {
            name: p.name,
            selection: pred ? pred.selection : "none",
            violated: pred ? pred.violated : false
        };
    }).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    
    playerPicks.forEach(p => {
        let pickClass = "none";
        let pickLabel = "Chưa chọn";
        
        if (p.violated) {
            pickClass = "violated";
            pickLabel = "Vi phạm";
        } else if (p.selection === "teamA") {
            pickClass = "teamA";
            pickLabel = match.teamA;
        } else if (p.selection === "teamB") {
            pickClass = "teamB";
            pickLabel = match.teamB;
        } else if (p.selection === "draw") {
            pickClass = "draw";
            pickLabel = "Hòa";
        } else if (p.selection === "hidden") {
            pickClass = "hidden";
            pickLabel = "Đã chọn";
        }
        
        playersListHtml += `
            <div class="player-pick-tag">
                <span class="player-pick-name" title="${p.name}">${p.name}</span>
                <span class="player-pick-selection ${pickClass}">${pickLabel}</span>
            </div>
        `;
    });
    
    return `
        ${distributionHtml}
        <div class="player-picks-grid">
            ${playersListHtml}
        </div>
    `;
}


// --- TIMER LOOP ---
function startCountdownTimer() {
    if (state.countdownInterval) clearInterval(state.countdownInterval);
    
    state.countdownInterval = setInterval(() => {
        const now = new Date();
        document.querySelectorAll("[data-kickoff]").forEach(el => {
            const kickoffStr = el.dataset.kickoff;
            
            // Calculate lock time (10:00 PM of previous day local time GMT+7)
            const kickoffDate = new Date(kickoffStr);
            
            // Convert to GMT+7 Date object values
            const offset = 7 * 60; // GMT+7 in minutes
            const localKickoffTime = new Date(kickoffDate.getTime() + offset * 60 * 1000);
            
            // Lock date is 1 day before
            const lockDate = new Date(localKickoffTime.getTime() - 24 * 60 * 60 * 1000);
            lockDate.setUTCHours(15, 0, 0, 0); // 15:00 UTC is 22:00 (10 PM) GMT+7
            
            const timeDiff = lockDate.getTime() - now.getTime();
            
            if (timeDiff <= 0) {
                el.className = "badge badge-danger";
                el.innerHTML = '<i class="fa-solid fa-lock"></i> Đã khóa bình chọn';
                el.removeAttribute("data-kickoff"); // Stop checking
                
                // Automatically refresh state when a match locks to ensure UI disables buttons
                setTimeout(() => refreshData(), 2000);
            } else {
                const hours = Math.floor(timeDiff / (1000 * 60 * 60));
                const minutes = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));
                
                if (hours < 1) {
                    el.className = "match-countdown badge-danger gold-glow animate-pulse";
                    el.innerHTML = `<i class="fa-solid fa-clock"></i> Sắp đóng - Còn ${minutes}p`;
                } else if (hours < 24) {
                    el.className = "match-countdown";
                    el.innerHTML = `<i class="fa-solid fa-clock"></i> Còn ${hours}h ${minutes}p`;
                } else {
                    const days = Math.floor(hours / 24);
                    const remHours = hours % 24;
                    el.className = "match-countdown badge-purple";
                    el.innerHTML = `<i class="fa-solid fa-clock"></i> Còn ${days} ngày ${remHours}h`;
                }
            }
        });
    }, 10000); // Check every 10 seconds
}

function formatKickoffTime(isoStr) {
    try {
        const date = new Date(isoStr);
        // Formats in local Vietnamese time
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        
        const dayOfWeekNames = ["Chủ Nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"];
        const dayOfWeek = dayOfWeekNames[date.getDay()];
        
        return `${hours}:${minutes} - ${dayOfWeek}, ${day}/${month}`;
    } catch (e) {
        return isoStr;
    }
}

// --- ADMIN PANELS RENDERING ---
function renderAdminControls() {
    if (!state.data || !state.adminToken) return;
    
    // 1. Render Admin Matches Tab
    const matchesList = document.getElementById("admin-matches-list");
    matchesList.innerHTML = "";
    
    state.data.matches.forEach(m => {
        const item = document.createElement("div");
        item.className = "admin-item";
        
        const checked = m.finished ? "checked" : "";
        
        item.innerHTML = `
            <div class="admin-item-top">
                <span class="admin-item-title">${m.teamA} vs ${m.teamB} (${m.stage_vn})</span>
                <span class="badge ${m.finished ? 'badge-green' : 'badge-gold'}">${m.finished ? 'Kết thúc' : 'Chờ đá'}</span>
            </div>
            <div class="admin-item-top">
                <div class="admin-item-inputs">
                    <input type="number" class="admin-score-input" id="admin-scoreA-${m.id}" value="${m.scoreA}" min="0">
                    <span class="text-muted">:</span>
                    <input type="number" class="admin-score-input" id="admin-scoreB-${m.id}" value="${m.scoreB}" min="0">
                    <label class="margin-left-10"><input type="checkbox" id="admin-finished-${m.id}" ${checked}> Xong</label>
                </div>
                <button class="btn btn-purple btn-sm" onclick="saveAdminMatchScore('${m.id}')">Lưu</button>
            </div>
        `;
        matchesList.appendChild(item);
    });
    
    // 2. Render Admin Players Tab
    const playersList = document.getElementById("admin-players-list");
    playersList.innerHTML = "";
    
    state.data.players.forEach(p => {
        const item = document.createElement("div");
        item.className = "admin-item";
        item.style.flexDirection = "row";
        item.style.justifyContent = "space-between";
        item.style.alignItems = "center";
        
        item.innerHTML = `
            <span class="admin-item-title">${p.name} ${p.has_pin ? '<i class="fa-solid fa-shield text-green" title="Đã cài PIN"></i>' : '<i class="fa-solid fa-shield-halved text-muted" title="Chưa cài PIN"></i>'}</span>
            <div class="header-actions">
                <button class="btn btn-dark btn-sm" onclick="resetPlayerPIN('${p.id}', '${p.name}')"><i class="fa-solid fa-key"></i> Reset PIN</button>
                <button class="btn btn-danger btn-sm" onclick="deletePlayer('${p.id}', '${p.name}')"><i class="fa-solid fa-trash"></i> Xóa</button>
            </div>
        `;
        playersList.appendChild(item);
    });
    
    // 3. Populate Override Dropdowns
    const matchSelect = document.getElementById("override-match-select");
    matchSelect.innerHTML = "";
    state.data.matches.forEach(m => {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = `${m.teamA} vs ${m.teamB} (${m.stage_vn})`;
        matchSelect.appendChild(opt);
    });
    
    const playerSelect = document.getElementById("override-player-select");
    playerSelect.innerHTML = "";
    state.data.players.forEach(p => {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name;
        playerSelect.appendChild(opt);
    });
    
    updateAdminOverrideLabels();
}

function updateAdminOverrideLabels() {
    const matchId = document.getElementById("override-match-select").value;
    if (!matchId || !state.data) return;
    const match = state.data.matches.find(m => m.id === matchId);
    if (!match) return;
    
    document.getElementById("override-teamA-label").textContent = match.teamA;
    document.getElementById("override-teamB-label").textContent = match.teamB;
}

// --- ADMIN API ACTIONS ---
async function saveAdminMatchScore(matchId) {
    const scoreA = document.getElementById(`admin-scoreA-${matchId}`).value;
    const scoreB = document.getElementById(`admin-scoreB-${matchId}`).value;
    const finished = document.getElementById(`admin-finished-${matchId}`).checked;
    
    if (scoreA === "" || scoreB === "") {
        showToast("Vui lòng nhập đầy đủ tỷ số", "error");
        return;
    }
    
    try {
        const res = await fetch("/api/admin/match", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": state.adminToken
            },
            body: JSON.stringify({ id: matchId, scoreA, scoreB, finished })
        });
        const result = await res.json();
        if (res.ok) {
            showToast("Đã cập nhật kết quả trận đấu!", "success");
            refreshData();
        } else {
            showToast(result.error || "Lỗi cập nhật", "error");
        }
    } catch (e) {
        showToast("Lỗi kết nối", "error");
    }
}

async function resetPlayerPIN(playerId, name) {
    if (!confirm(`Bạn có chắc chắn muốn reset mã PIN của ${name}? Sau khi reset, người này có thể tạo mã PIN mới ở lần đăng nhập tiếp theo.`)) return;
    
    try {
        const res = await fetch("/api/admin/player", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": state.adminToken
            },
            body: JSON.stringify({ action: "update", id: playerId, reset_pin: true })
        });
        if (res.ok) {
            showToast(`Đã reset PIN của ${name}`, "success");
            refreshData();
        } else {
            showToast("Lỗi reset PIN", "error");
        }
    } catch (e) {
        showToast("Lỗi kết nối", "error");
    }
}

async function deletePlayer(playerId, name) {
    if (!confirm(`CẢNH BÁO: Bạn có chắc chắn muốn xóa thành viên ${name}? Mọi bình chọn của người này cũng sẽ bị xóa vĩnh viễn và không thể khôi phục.`)) return;
    
    try {
        const res = await fetch("/api/admin/player", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": state.adminToken
            },
            body: JSON.stringify({ action: "delete", id: playerId })
        });
        if (res.ok) {
            showToast(`Đã xóa thành viên ${name}`, "success");
            // If deleting self, logout
            if (state.currentUser && state.currentUser.player_id === playerId) {
                logout();
            } else {
                refreshData();
            }
        } else {
            showToast("Lỗi xóa thành viên", "error");
        }
    } catch (e) {
        showToast("Lỗi kết nối", "error");
    }
}

// --- CALCULATE GROUP STANDINGS ---
function calculateGroupStandings() {
    if (!state.data || !state.data.matches) return [];

    const groupMatches = state.data.matches.filter(m => m.stage === "group-stage");

    // 1. Group teams by connected components (cliques of 4)
    const adj = {};
    groupMatches.forEach(m => {
        if (!adj[m.teamA]) adj[m.teamA] = new Set();
        if (!adj[m.teamB]) adj[m.teamB] = new Set();
        adj[m.teamA].add(m.teamB);
        adj[m.teamB].add(m.teamA);
    });

    const visited = new Set();
    const groups = [];

    // Traverse sorted team keys for stable group sorting
    const sortedTeams = Object.keys(adj).sort();
    sortedTeams.forEach(t => {
        if (!visited.has(t)) {
            const groupTeams = [t];
            visited.add(t);
            adj[t].forEach(n => {
                if (!visited.has(n)) {
                    groupTeams.push(n);
                    visited.add(n);
                }
            });
            groups.push(groupTeams);
        }
    });

    // Helper to determine actual group letter based on official representative teams
    function getGroupLetter(teamsList) {
        const representatives = {
            "Mexico": "A",
            "Canada": "B",
            "Brazil": "C",
            "United States": "D",
            "USA": "D",
            "Germany": "E",
            "Japan": "F",
            "Belgium": "G",
            "Spain": "H",
            "France": "I",
            "Argentina": "J",
            "Portugal": "K",
            "England": "L"
        };
        for (let t of teamsList) {
            if (representatives[t]) {
                return representatives[t];
            }
        }
        return null;
    }

    // 2. Compute statistics for each team in each group
    const standings = groups.map((teams, index) => {
        const groupLetter = getGroupLetter(teams) || String.fromCharCode(65 + index);

        const teamStats = teams.map(teamName => {
            const stats = {
                name: teamName,
                logo: "",
                played: 0,
                won: 0,
                drawn: 0,
                lost: 0,
                gf: 0,
                ga: 0,
                gd: 0,
                pts: 0
            };

            // Retrieve team flag
            const matchWithLogo = groupMatches.find(m => m.teamA === teamName || m.teamB === teamName);
            if (matchWithLogo) {
                stats.logo = matchWithLogo.teamA === teamName ? matchWithLogo.teamA_logo : matchWithLogo.teamB_logo;
            }

            // Calculate played, won, drawn, lost, gf, ga, gd, pts
            groupMatches.forEach(m => {
                if (!m.finished) return;
                
                if (m.teamA === teamName) {
                    stats.played++;
                    stats.gf += m.scoreA;
                    stats.ga += m.scoreB;
                    if (m.scoreA > m.scoreB) {
                        stats.won++;
                        stats.pts += 3;
                    } else if (m.scoreA === m.scoreB) {
                        stats.drawn++;
                        stats.pts += 1;
                    } else {
                        stats.lost++;
                    }
                } else if (m.teamB === teamName) {
                    stats.played++;
                    stats.gf += m.scoreB;
                    stats.ga += m.scoreA;
                    if (m.scoreB > m.scoreA) {
                        stats.won++;
                        stats.pts += 3;
                    } else if (m.scoreA === m.scoreB) {
                        stats.drawn++;
                        stats.pts += 1;
                    } else {
                        stats.lost++;
                    }
                }
            });

            stats.gd = stats.gf - stats.ga;
            return stats;
        });

        // Tie-breaker rules: 1. Points, 2. GD, 3. GF, 4. Alphabetical
        teamStats.sort((a, b) => {
            if (b.pts !== a.pts) return b.pts - a.pts;
            if (b.gd !== a.gd) return b.gd - a.gd;
            if (b.gf !== a.gf) return b.gf - a.gf;
            return a.name.localeCompare(b.name, 'vi');
        });

        return {
            groupName: `Bảng ${groupLetter}`,
            teams: teamStats
        };
    });

    standings.sort((a, b) => a.groupName.localeCompare(b.groupName));
    return standings;
}

// --- RENDER TEAM STANDINGS (TAB 4) ---
function renderStandings() {
    if (!state.data) return;
    
    const container = document.getElementById("standings-container");
    if (!container) return;
    container.innerHTML = "";
    
    const standings = calculateGroupStandings();
    
    standings.forEach(group => {
        const card = document.createElement("div");
        card.className = "card glass-card group-standings-card animate-fade-in";
        
        let teamRowsHtml = "";
        group.teams.forEach((t, idx) => {
            const gdSign = t.gd > 0 ? "+" : "";
            
            let rankHtml = `<span class="rank-badge">${idx + 1}</span>`;
            if (idx === 0) rankHtml = `<span class="rank-badge rank-1"><i class="fa-solid fa-crown"></i></span>`;
            else if (idx === 1) rankHtml = `<span class="rank-badge rank-2">2</span>`;
            else if (idx === 2) rankHtml = `<span class="rank-badge rank-3">3</span>`;
            
            teamRowsHtml += `
                <tr>
                    <td class="text-center">${rankHtml}</td>
                    <td class="team-name-cell">
                        <img src="${t.logo}" onerror="this.src='/static/images/wc_trophy_bg.png'" class="team-logo-small" alt="${t.name}">
                        <span class="team-display-name">${t.name}</span>
                    </td>
                    <td class="text-center">${t.played}</td>
                    <td class="text-center">${gdSign}${t.gd}</td>
                    <td class="text-right table-pts-value" style="padding-right: 15px;">${t.pts}</td>
                </tr>
            `;
        });
        
        card.innerHTML = `
            <div class="card-header">
                <h2><i class="fa-solid fa-trophy text-gold"></i> ${group.groupName}</h2>
            </div>
            <div class="card-body no-padding">
                <table class="standings-table">
                    <thead>
                        <tr>
                            <th class="text-center" style="width: 35px;">#</th>
                            <th>Đội tuyển</th>
                            <th class="text-center" style="width: 50px;">Trận</th>
                            <th class="text-center" style="width: 50px;">H.Số</th>
                            <th class="text-right" style="width: 50px; padding-right: 15px;">Điểm</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${teamRowsHtml}
                    </tbody>
                </table>
            </div>
        `;
        
        container.appendChild(card);
    });
}

// --- SUB-TAB SWITCHING IN STANDINGS ---
function switchSubStandingsTab(subTab) {
    const btnGroups = document.getElementById("btn-sub-groups");
    const btnBracket = document.getElementById("btn-sub-bracket");
    const standingsContainer = document.getElementById("standings-container");
    const bracketContainer = document.getElementById("bracket-container");
    
    if (subTab === "groups") {
        btnGroups.classList.add("active");
        btnBracket.classList.remove("active");
        standingsContainer.classList.remove("hidden");
        bracketContainer.classList.add("hidden");
    } else {
        btnGroups.classList.remove("active");
        btnBracket.classList.add("active");
        standingsContainer.classList.add("hidden");
        bracketContainer.classList.remove("hidden");
        renderBracket();
    }
}

// --- SHORTEN ESPN PLACEHOLDER TEAM NAMES ---
function shortenTeamName(name) {
    if (!name) return "TBD";
    // "Group A Winner" → "1A"
    let m = name.match(/Group ([A-Z]) Winner/i);
    if (m) return `1${m[1]}`;
    // "Group A 2nd Place" → "2A"
    m = name.match(/Group ([A-Z]) 2nd Place/i);
    if (m) return `2${m[1]}`;
    // "Group A 1st Place" → "1A"
    m = name.match(/Group ([A-Z]) 1st Place/i);
    if (m) return `1${m[1]}`;
    // "Group A 3rd Place" → "3A"
    m = name.match(/Group ([A-Z]) 3rd Place/i);
    if (m) return `3${m[1]}`;
    // "Third Place Group A/B/C/D" → "3rd (A/B/C/D)"
    m = name.match(/Third Place Group ([A-Z/]+)/i);
    if (m) return `3rd (${m[1]})`;
    // "Winner Match X" → just return as-is shortened
    return name;
}

// --- RENDER KNOCKOUT BRACKET (TAB 4 SUB-TAB 2) ---
function renderBracket() {
    if (!state.data || !state.data.matches) return;
    const verticalArea = document.getElementById("bracket-vertical-area");
    if (!verticalArea) return;
    verticalArea.innerHTML = "";
    
    const matches = state.data.matches;
    
    // Define the rounds in descending order (Final at top for better UX, or click pills to jump)
    const stages = [
        { name: "Vòng 32", slug: "round-of-32", id: "sect-r32", icon: "fa-circle-play" },
        { name: "Vòng 1/16 (Vòng 16)", slug: "round-of-16", id: "sect-r16", icon: "fa-circle-play" },
        { name: "Tứ Kết", slug: "quarterfinals", id: "sect-qf", icon: "fa-circle-play" },
        { name: "Bán Kết", slug: "semifinals", id: "sect-sf", icon: "fa-circle-play" },
        { name: "Chung Kết & Tranh Hạng 3", slug: "final", id: "sect-final", icon: "fa-trophy" }
    ];
    
    stages.forEach(stage => {
        const section = document.createElement("div");
        section.id = stage.id;
        section.className = "bracket-section animate-fade-in";
        
        const header = document.createElement("div");
        header.className = "bracket-section-header";
        header.innerHTML = `<i class="fa-solid ${stage.icon} text-gold"></i> ${stage.name}`;
        section.appendChild(header);
        
        const grid = document.createElement("div");
        grid.className = "bracket-match-grid";
        
        let stageMatches = [];
        if (stage.slug === "final") {
            stageMatches = matches.filter(m => m.stage === "final" || m.stage === "3rd-place-match");
            // Final is stage="final", 3rd-place-match is stage="3rd-place-match". Sort to keep final at the bottom
            stageMatches.sort((a, b) => b.stage.localeCompare(a.stage));
        } else {
            stageMatches = matches.filter(m => m.stage === stage.slug);
        }
        
        if (stageMatches.length === 0) return;
        
        stageMatches.forEach(m => {
            const matchCard = document.createElement("div");
            matchCard.className = "bracket-match-card";
            
            const isFinished = m.finished;
            const scoreA = isFinished ? m.scoreA : "";
            const scoreB = isFinished ? m.scoreB : "";
            
            const isWinnerA = isFinished && m.scoreA > m.scoreB;
            const isWinnerB = isFinished && m.scoreB > m.scoreA;
            
            const localTime = formatKickoffTime(m.kickoff);
            
            // Look up correct team flag from group stage matches if empty
            let logoA = m.teamA_logo;
            let logoB = m.teamB_logo;
            
            if (!logoA || logoA === "") {
                const foundMatch = matches.find(gm => (gm.teamA === m.teamA && gm.teamA_logo) || (gm.teamB === m.teamA && gm.teamB_logo));
                if (foundMatch) {
                    logoA = foundMatch.teamA === m.teamA ? foundMatch.teamA_logo : foundMatch.teamB_logo;
                }
            }
            if (!logoB || logoB === "") {
                const foundMatch = matches.find(gm => (gm.teamA === m.teamB && gm.teamA_logo) || (gm.teamB === m.teamB && gm.teamB_logo));
                if (foundMatch) {
                    logoB = foundMatch.teamA === m.teamB ? foundMatch.teamA_logo : foundMatch.teamB_logo;
                }
            }

            // Format stage name for meta
            let stageVn = m.stage_vn;
            if (m.stage === "3rd-place-match") stageVn = "Tranh Hạng 3";
            else if (m.stage === "final") stageVn = "Chung Kết";
            
            const timeOnly = localTime.split(" - ")[0];
            const dateOnly = localTime.split(" - ")[1] ? localTime.split(" - ")[1].split(", ")[1] : "";
            const metaTimeStr = isFinished ? "Đã kết thúc" : `${timeOnly} (${dateOnly})`;
            
            // Display shortened names for TBD placeholder slots
            const displayNameA = isFinished ? m.teamA : shortenTeamName(m.teamA);
            const displayNameB = isFinished ? m.teamB : shortenTeamName(m.teamB);
            // If shortened, show in a distinct style
            const isPlaceholderA = displayNameA !== m.teamA;
            const isPlaceholderB = displayNameB !== m.teamB;

            matchCard.innerHTML = `
                <div class="bracket-team-row ${isWinnerA ? 'winner' : ''}">
                    <div class="bracket-team-info">
                        <img src="${logoA}" onerror="this.src='/static/images/wc_trophy_bg.png'" class="bracket-team-logo" alt="${m.teamA}">
                        <span class="team-display-name ${isPlaceholderA ? 'placeholder-slot' : ''}" title="${m.teamA}">${displayNameA}</span>
                    </div>
                    <div class="bracket-team-score">${scoreA}</div>
                </div>
                <div class="bracket-team-row ${isWinnerB ? 'winner' : ''}">
                    <div class="bracket-team-info">
                        <img src="${logoB}" onerror="this.src='/static/images/wc_trophy_bg.png'" class="bracket-team-logo" alt="${m.teamB}">
                        <span class="team-display-name ${isPlaceholderB ? 'placeholder-slot' : ''}" title="${m.teamB}">${displayNameB}</span>
                    </div>
                    <div class="bracket-team-score">${scoreB}</div>
                </div>
                <div class="bracket-match-meta">
                    <span>${stageVn}</span>
                    <span>${metaTimeStr}</span>
                </div>
            `;
            
            grid.appendChild(matchCard);
        });
        
        section.appendChild(grid);
        verticalArea.appendChild(section);
    });
}

// --- SMOOTH SCROLL TO BRACKET SECTION ---
function scrollToBracketSection(sectId) {
    const el = document.getElementById(sectId);
    if (el) {
        // Offset for the main header (~120px) + navigation pills (~60px)
        const offset = 195;
        const bodyRect = document.body.getBoundingClientRect().top;
        const elementRect = el.getBoundingClientRect().top;
        const elementPosition = elementRect - bodyRect;
        const offsetPosition = elementPosition - offset;

        window.scrollTo({
            top: offsetPosition,
            behavior: 'smooth'
        });
        
        // Highlight active pill button
        document.querySelectorAll(".bracket-pill-btn").forEach(btn => {
            btn.classList.remove("active");
            if (btn.getAttribute("onclick").includes(sectId)) {
                btn.classList.add("active");
            }
        });
    }
}
