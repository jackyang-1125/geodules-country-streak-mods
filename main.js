// ==UserScript==
// @name         GeoDuels Country Streak Tracker (Competition Edition)
// @namespace    https://geoduels.io/
// @version      beta 29.9.9
// @description  Tracks an unlimited country streak, supports timed competition rounds, and provides a Supabase-backed leaderboard.
// @match        https://geoduels.io/*
// @match        https://*.geoduels.io/*
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.bigdatacloud.net
// @connect      nominatim.openstreetmap.org
// @connect      marineregions.org
// @connect      bwthsdhedsepzwzdomrm.supabase.co
// @run-at       document-start
// ==/UserScript==

(() => {
    "use strict";

    const targetWin = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    if (window.top !== window.self) return;

    const SUPABASE_URL = "https://bwthsdhedsepzwzdomrm.supabase.co";
    const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_eu7dmrMLdZ_927ZTqmJMdQ_ShvthBLh";
    const STORAGE_KEY = "gd-streak:state:v10";
    const SETTINGS_KEY = "gd-streak:settings:v10";
    const LEGACY_STORAGE_KEYS = ["gd-streak:state:v9", "gd-streak:state:v8"];
    const LEGACY_SETTINGS_KEYS = ["gd-streak:settings:v9", "gd-streak:settings:v8"];
    const MAX_PRACTICE_SECONDS = 3600;
    const COMPETITION_SECONDS = 120;
    const COMPETITION_RULESET = "moving";
    const COMPETITION_STREET_NAMES = "hidden";
    const REACT_HYDRATION_DELAY_MS = 1200;
    const REVERSE_GEOCODE_TIMEOUT_MS = 3000;
    const COMPETITION_INTENT_KEY = "gd-streak:competition-intent:v1";
    const LEADERBOARD_ACCOUNT_SESSION_KEY = "gd-streak:leaderboard-account-session:v1";
    const LEADERBOARD_ACCOUNT_STORAGE_KEY = "gd-streak:leaderboard-account:v1";
    const COUNTRY_STREAK_INTENT_KEY = "gd-streak:country-streak-intent:v1";
    const FIFTH_FORCE_RETRY_KEY = "gd-streak:fifth-force-retry:v1";
    const AUTO_RESTART_MAX_AGE_MS = 30000;

    function readJSON(key) {
        try {
            const value = localStorage.getItem(key);
            return value ? JSON.parse(value) : null;
        } catch (_) {
            return null;
        }
    }

    function clampInteger(value, min, max) {
        const number = Number(value);
        if (!Number.isFinite(number)) return min;
        return Math.min(max, Math.max(min, Math.round(number)));
    }

    function toTimestampMs(value) {
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
            return value < 100000000000 ? value * 1000 : value;
        }
        if (typeof value === "string" && value.trim()) {
            const numeric = Number(value);
            if (Number.isFinite(numeric) && numeric > 0) return numeric < 100000000000 ? numeric * 1000 : numeric;
            const parsed = Date.parse(value);
            if (Number.isFinite(parsed) && parsed > 0) return parsed;
        }
        return 0;
    }

    function loadSettings() {
        const saved = readJSON(SETTINGS_KEY) || LEGACY_SETTINGS_KEYS.map(readJSON).find(Boolean) || {};
        return {
            enabled: saved.enabled === true,
            competitionMode: saved.competitionMode === true,
            practiceSeconds: clampInteger(saved.practiceSeconds, 0, MAX_PRACTICE_SECONDS),
            leaderboardEnabled: saved.leaderboardEnabled !== false,
            leaderboardAccountName: typeof saved.leaderboardAccountName === "string"
                ? saved.leaderboardAccountName
                : (typeof saved.leaderboardDisplayName === "string" ? saved.leaderboardDisplayName : ""),
            leaderboardDisplayName: typeof saved.leaderboardDisplayName === "string" ? saved.leaderboardDisplayName : "",
            nicknameChoiceAsked: saved.nicknameChoiceAsked === true,
            countryStreakRuleset: ["moving", "no_move", "nmpz"].includes(saved.countryStreakRuleset) ? saved.countryStreakRuleset : "moving",
            countryStreakStreetNames: saved.countryStreakStreetNames === "hidden" ? "hidden" : "shown"
        };
    }

    const settings = loadSettings();

    let toastHost = null;
    let toastCounter = 0;
    let nicknameChoicePromptPromise = null;
    let leaderboardHashSetupPromise = null;

    function ensureToastHost() {
        if (toastHost?.isConnected) return toastHost;
        const parent = document.body || document.documentElement;
        if (!parent) return null;
        toastHost = document.createElement("div");
        toastHost.id = "gd-country-streak-toast-host";
        toastHost.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;display:flex;flex-direction:column;align-items:stretch;gap:12px;width:min(430px,calc(100vw - 32px));pointer-events:none;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;";
        parent.appendChild(toastHost);
        return toastHost;
    }

    function showToastCard({ title = "Country Streak", message = "", tone = "info", input = null, buttons = [], duration = 0 } = {}) {
        const host = ensureToastHost();
        if (!host) return Promise.resolve(null);
        return new Promise((resolve) => {
            const id = `gd-toast-${++toastCounter}`;
            const colors = {
                info: ["#c4b5fd", "rgba(139,92,246,.22)", "rgba(124,58,237,.36)"],
                success: ["#86efac", "rgba(34,197,94,.20)", "rgba(22,101,52,.42)"],
                warning: ["#fde68a", "rgba(245,158,11,.20)", "rgba(120,53,15,.44)"],
                error: ["#fca5a5", "rgba(239,68,68,.20)", "rgba(127,29,29,.44)"]
            }[tone] || ["#c4b5fd", "rgba(139,92,246,.22)", "rgba(124,58,237,.36)"];
            const card = document.createElement("section");
            card.id = id;
            card.setAttribute("role", buttons.length || input ? "dialog" : "status");
            card.setAttribute("aria-live", "polite");
            card.style.cssText = `pointer-events:auto;box-sizing:border-box;overflow:hidden;border:1px solid ${colors[0]}55;border-radius:20px;background:linear-gradient(145deg,rgba(16,24,38,.98),rgba(18,10,32,.98));box-shadow:0 18px 55px rgba(0,0,0,.42),0 0 0 1px rgba(255,255,255,.035) inset;transform:translateY(-8px) scale(.98);opacity:0;transition:transform .22s ease,opacity .22s ease;`;
            const accent = document.createElement("div");
            accent.style.cssText = `height:3px;background:linear-gradient(90deg,${colors[0]},${colors[2]});`;
            const content = document.createElement("div");
            content.style.cssText = "padding:15px 16px 14px;";
            const header = document.createElement("div");
            header.style.cssText = "display:flex;align-items:flex-start;gap:12px;";
            const mark = document.createElement("div");
            mark.textContent = tone === "success" ? "✓" : tone === "error" ? "!" : tone === "warning" ? "!" : "✦";
            mark.style.cssText = `display:flex;flex:0 0 28px;width:28px;height:28px;align-items:center;justify-content:center;border-radius:10px;background:${colors[1]};color:${colors[0]};font-size:15px;font-weight:1000;`;
            const heading = document.createElement("div");
            heading.style.cssText = "min-width:0;flex:1;";
            const titleElement = document.createElement("strong");
            titleElement.textContent = title;
            titleElement.style.cssText = "display:block;color:#fff;font-size:14px;font-weight:950;letter-spacing:.01em;line-height:1.25;";
            const messageElement = document.createElement("div");
            messageElement.textContent = message;
            messageElement.style.cssText = "margin-top:6px;color:#c8d4e3;font-size:12px;line-height:1.5;white-space:pre-line;overflow-wrap:anywhere;";
            heading.append(titleElement, messageElement);
            const dismiss = document.createElement("button");
            dismiss.type = "button";
            dismiss.setAttribute("aria-label", "Close notification");
            dismiss.textContent = "×";
            dismiss.style.cssText = "flex:0 0 auto;width:27px;height:27px;border:0;border-radius:9px;background:rgba(255,255,255,.06);color:#b7c5d6;font-size:19px;line-height:1;cursor:pointer;";
            header.append(mark, heading, dismiss);
            content.appendChild(header);
            let inputElement = null;
            if (input) {
                inputElement = document.createElement("input");
                inputElement.type = input.type || "text";
                inputElement.value = input.value || "";
                inputElement.placeholder = input.placeholder || "";
                if (input.maxLength) inputElement.maxLength = input.maxLength;
                inputElement.readOnly = input.readOnly === true;
                inputElement.autocomplete = "off";
                inputElement.style.cssText = "display:block;width:100%;box-sizing:border-box;margin-top:13px;border:1px solid rgba(196,181,253,.28);border-radius:11px;background:rgba(0,0,0,.24);padding:10px 11px;color:#fff;outline:none;font-size:13px;line-height:1.2;";
                content.appendChild(inputElement);
            }
            const actionRow = document.createElement("div");
            actionRow.style.cssText = "display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;margin-top:14px;";
            let settled = false;
            const close = (value) => {
                if (settled) return;
                settled = true;
                card.style.transform = "translateY(-5px) scale(.98)";
                card.style.opacity = "0";
                targetWin.setTimeout(() => card.remove(), 220);
                resolve(value);
            };
            dismiss.addEventListener("click", () => close(null), true);
            for (const definition of buttons) {
                const button = document.createElement("button");
                button.type = "button";
                button.textContent = definition.label;
                button.style.cssText = `min-height:34px;border:1px solid ${definition.kind === "primary" ? colors[0] + "66" : "rgba(255,255,255,.13)"};border-radius:10px;padding:7px 12px;background:${definition.kind === "primary" ? colors[2] : "rgba(255,255,255,.06)"};color:${definition.kind === "primary" ? "#fff" : "#dbe7ff"};font-size:11px;font-weight:900;letter-spacing:.05em;cursor:pointer;`;
                button.addEventListener("click", () => {
                    if (typeof definition.onClick === "function") definition.onClick(inputElement?.value || "");
                    if (!definition.keepOpen) close({ action: definition.value || definition.label, value: inputElement?.value || "" });
                }, true);
                actionRow.appendChild(button);
            }
            if (buttons.length) content.appendChild(actionRow);
            card.append(accent, content);
            host.appendChild(card);
            targetWin.requestAnimationFrame(() => {
                card.style.transform = "translateY(0) scale(1)";
                card.style.opacity = "1";
            });
            if (inputElement) targetWin.setTimeout(() => inputElement.focus(), 50);
            if (!buttons.length) targetWin.setTimeout(() => close(null), duration || 4200);
        });
    }

    function showToastNotice(message, options = {}) {
        void showToastCard({ ...options, message, buttons: [], duration: options.duration || 4600 });
    }

    async function showRecoveryIdToast(accountName, recoveryId, title = "Your Recovery ID") {
        await showToastCard({
            title,
            message: `Leaderboard account: ${accountName}\nKeep this ID somewhere safe. It is not saved by this script or in cookies.`,
            input: { value: recoveryId, maxLength: 32, readOnly: true },
            buttons: [
                { label: "COPY RECOVERY ID", value: "copy", kind: "primary", keepOpen: true, onClick: (value) => {
                    try { targetWin.navigator.clipboard?.writeText(value); } catch (_) {}
                    showToastNotice("Recovery ID copied when the browser permits clipboard access.", { title: "Copied", tone: "success", duration: 2600 });
                } },
                { label: "DONE", value: "done" }
            ],
            tone: "success"
        });
    }

    function normalizeLoss(loss) {
        if (!loss || typeof loss !== "object") return null;
        return {
            finalStreak: Math.max(0, Number(loss.finalStreak) || 0),
            guessedCountry: typeof loss.guessedCountry === "string" ? loss.guessedCountry : "Unknown",
            actualCountry: typeof loss.actualCountry === "string" ? loss.actualCountry : "Unknown",
            round: Math.max(1, Number(loss.round) || 1)
        };
    }

    function normalizeEvent(event) {
        if (!event || typeof event !== "object") return null;
        const roundNumber = Math.max(1, Number(event.roundNumber) || 1);
        const resultAtMs = Number(event.resultAtMs);
        const startedAtMs = Number(event.startedAtMs);
        return {
            roundNumber,
            roundId: typeof event.roundId === "string" ? event.roundId : "",
            actualCountryCode: typeof event.actualCountryCode === "string" ? event.actualCountryCode.toUpperCase() : "",
            guessedCountryCode: typeof event.guessedCountryCode === "string" ? event.guessedCountryCode.toUpperCase() : "",
            isCorrect: event.isCorrect === true,
            startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
            resultAtMs: Number.isFinite(resultAtMs) ? resultAtMs : Date.now(),
            elapsedMs: clampInteger(event.elapsedMs, 0, 86400000),
            previousHash: typeof event.previousHash === "string" ? event.previousHash : "GENESIS",
            eventHash: typeof event.eventHash === "string" ? event.eventHash : ""
        };
    }

    function normalizeState(saved) {
        const source = saved && typeof saved === "object" ? saved : {};
        const events = Array.isArray(source.activeEvents) ? source.activeEvents.map(normalizeEvent).filter(Boolean) : [];
        const bestStreak = Math.max(0, Number(source.bestStreak) || 0);
        const competitionBestStreak = Math.max(0, Number(source.competitionBestStreak) || 0);
        const rawActiveBestStreakBefore = Number(source.activeBestStreakBefore);
        const activeBestStreakBefore = Number.isFinite(rawActiveBestStreakBefore)
            ? Math.max(0, rawActiveBestStreakBefore)
            : bestStreak;
        const rawActiveCompetitionBestBefore = Number(source.activeCompetitionBestBefore);
        const activeCompetitionBestBefore = Number.isFinite(rawActiveCompetitionBestBefore)
            ? Math.max(0, rawActiveCompetitionBestBefore)
            : competitionBestStreak;
        return {
            currentStreak: Math.max(0, Number(source.currentStreak) || 0),
            bestStreak,
            competitionBestStreak,
            activeBestStreakBefore,
            activeCompetitionBestBefore,
            lastStreak: Math.max(0, Number(source.lastStreak) || 0),
            totalGuessed: Math.max(0, Number(source.totalGuessed) || 0),
            totalCorrect: Math.max(0, Number(source.totalCorrect) || 0),
            lastLoss: normalizeLoss(source.lastLoss),
            activeMatchId: typeof source.activeMatchId === "string" ? source.activeMatchId : "",
            activeMatchStartedAtMs: Number(source.activeMatchStartedAtMs) || 0,
            activeRoundId: typeof source.activeRoundId === "string" ? source.activeRoundId : "",
            activeRoundStartedAtMs: Number(source.activeRoundStartedAtMs) || 0,
            activeStreakBefore: Math.max(0, Number(source.activeStreakBefore) || 0),
            activeEvents: events,
            submittedCompetitionMatches: Array.isArray(source.submittedCompetitionMatches)
                ? source.submittedCompetitionMatches.filter((value) => typeof value === "string").slice(-50)
                : []
        };
    }

    function loadState() {
        const saved = readJSON(STORAGE_KEY) || LEGACY_STORAGE_KEYS.map(readJSON).find(Boolean);
        return normalizeState(saved);
    }

    const state = loadState();

    let sessionCache = null;
    let sessionPromise = null;
    let leaderboardPanel = null;
    let leaderboardTab = null;
    let leaderboardHistoryEntryPushed = false;
    let leaderboardBackHandlerInstalled = false;
    let countryStreakCard = null;
    let countryStreakCardStyleElement = null;
    let countryStreakCardObserver = null;
    let countryStreakRules = { ruleset: settings.countryStreakRuleset, streetNames: settings.countryStreakStreetNames };
    let leaderboardRows = [];
    let leaderboardAccount = null;
    let leaderboardIdentityPromise = null;
    let leaderboardLoading = false;
    let avatarLookupRequested = false;
    let activeSocket = null;
    let currentRoundId = "";
    let currentRoundNumber = 0;
    let currentRoundStartedAtMs = 0;
    let currentRoundExpired = false;
    let latestSnapshot = null;
    let pendingInitialLiveSnapshot = null;
    let latestMatchConfig = null;
    let latestRoundNumber = 0;
    let latestRoundCount = 0;
    let matchEnded = false;
    let nextMatchStartPromise = null;
    let existingRoundAdvancePromise = null;
    let fifthRouteRetryTimer = null;
    let fifthHomeRetryInFlight = false;
    let gameOverOverlay = null;
    let gameOverOverlayKey = "";
    let failureUiRepairTimer = null;
    let lastRoundSummary = null;
    let countryStreakStageOverlay = null;
    let countryStreakFifthNextControl = null;
    const nativeResultOriginalStyles = new WeakMap();
    const nativeResultStyledElements = new Set();
    const nativeMatchEndOriginalStyles = new WeakMap();
    const nativeMatchEndStyledElements = new Set();
    const processedResultKeys = new Set();
    let evaluationInFlight = null;
    let countryStreakFailureTransitionLock = false;
    let countryStreakFailureMatchId = "";
    let fifthRoundClickFallbackInstalled = false;
    let gameOverRevealRequested = false;
    const failureTransitionHiddenElements = new Map();
    let failureTransitionObserver = null;
    let failureClickBlockerInstalled = false;
    let isSingleplayer = false;
    let matchId = null;
    let roundIndex = 0;
    let timerElement = null;
    let timerHost = null;
    let timerInterval = null;
    let reactHydrationSettled = false;
    let initialTimerSyncDone = false;
    let pendingSubmissionPromises = new Map();
    const finalizedGuessByRound = new Map();
    const latestFinalizedGuessByMatch = new Map();
    const seenRoundKeys = new Set(state.activeEvents.map((event) => `${event.roundId || "round"}:${event.roundNumber}:${event.resultAtMs}`));
    const geoCache = new Map();

    function hasCompetitionLaunchIntent() {
        try {
            return targetWin.sessionStorage.getItem(COMPETITION_INTENT_KEY) === "1";
        } catch (_) {
            return false;
        }
    }

    function setCountryStreakIntent() {
        try {
            targetWin.sessionStorage.setItem(COUNTRY_STREAK_INTENT_KEY, "1");
        } catch (_) {}
        isSingleplayer = true;
    }

    function hasCountryStreakIntent() {
        try {
            return targetWin.sessionStorage.getItem(COUNTRY_STREAK_INTENT_KEY) === "1"
                || targetWin.sessionStorage.getItem(COMPETITION_INTENT_KEY) === "1";
        } catch (_) {
            return false;
        }
    }

    function clearCountryStreakIntent() {
        try {
            targetWin.sessionStorage.removeItem(COUNTRY_STREAK_INTENT_KEY);
        } catch (_) {}
    }

    function setCompetitionLaunchIntent() {
        setCountryStreakIntent();
        try {
            targetWin.sessionStorage.setItem(COMPETITION_INTENT_KEY, "1");
        } catch (_) {}
        isSingleplayer = true;
    }

    function clearCompetitionLaunchIntent() {
        try {
            targetWin.sessionStorage.removeItem(COMPETITION_INTENT_KEY);
        } catch (_) {}
    }

    function setAutomaticCountryStreakRestart(rules) {
        try {
            targetWin.sessionStorage.setItem(FIFTH_FORCE_RETRY_KEY, JSON.stringify({
                ruleset: rules?.ruleset || settings.countryStreakRuleset || "moving",
                streetNames: rules?.streetNames || settings.countryStreakStreetNames || "shown",
                createdAt: Date.now()
            }));
        } catch (_) {}
    }

    function takeAutomaticCountryStreakRestart() {
        try {
            const raw = targetWin.sessionStorage.getItem(FIFTH_FORCE_RETRY_KEY);
            if (!raw) return null;
            targetWin.sessionStorage.removeItem(FIFTH_FORCE_RETRY_KEY);
            const value = JSON.parse(raw);
            if (!value || Date.now() - Number(value.createdAt || 0) > AUTO_RESTART_MAX_AGE_MS) return null;
            return {
                ruleset: ["moving", "no_move", "nmpz"].includes(value.ruleset) ? value.ruleset : "moving",
                streetNames: value.streetNames === "hidden" ? "hidden" : "shown"
            };
        } catch (_) {
            return null;
        }
    }

    function isInSingleplayer() {
        const gameRoute = /\/(singleplayer|practice)\b/i.test(location.pathname) || /\/match\//i.test(location.pathname);
        return hasCountryStreakIntent() && (gameRoute || isSingleplayer);
    }

    function ensureCountryStreakInitialFrameStyle() {
        if (document.getElementById("gd-country-streak-initial-lock-style")) return;
        const style = document.createElement("style");
        style.id = "gd-country-streak-initial-lock-style";
        style.textContent = `.gd-country-streak-initial-frame-lock [class*="right-3"][class*="top-3"][class*="z-30"], .gd-country-streak-initial-frame-lock [class*="app-layer-match-end"]:not(#gd-game-over-overlay), .gd-country-streak-initial-frame-lock [class*="match-end"]:not(#gd-game-over-overlay) { display:none !important; visibility:hidden !important; pointer-events:none !important; }`;
        (document.head || document.documentElement)?.appendChild(style);
    }

    function setCountryStreakInitialFrameLock(active) {
        const locked = Boolean(active);
        document.documentElement?.classList.toggle("gd-country-streak-initial-frame-lock", locked);
        document.body?.classList.toggle("gd-country-streak-initial-frame-lock", locked);
    }

    function installCountryStreakInitialFrameGuard() {
        const gameRoute = /\/(singleplayer|practice)\b/i.test(location.pathname) || /\/match\//i.test(location.pathname);
        if (!settings.enabled || !hasCountryStreakIntent() || !gameRoute) return;
        isSingleplayer = true;
        ensureCountryStreakInitialFrameStyle();
        setCountryStreakInitialFrameLock(true);
    }

    function isCompetitionMode() {
        return settings.enabled && settings.competitionMode && isInSingleplayer();
    }

    function shouldForceCompetitionLaunch() {
        return hasCountryStreakIntent() && settings.enabled && settings.competitionMode;
    }

    function getConfiguredSeconds() {
        if (!settings.enabled || !isInSingleplayer()) return 0;
        return settings.competitionMode ? COMPETITION_SECONDS : clampInteger(settings.practiceSeconds, 0, MAX_PRACTICE_SECONDS);
    }

    function getApiURL(path) {
        const configuredBase = targetWin.__GEODUELS_CONFIG__?.NEXT_PUBLIC_API_URL;
        if (typeof configuredBase === "string" && configuredBase && !configuredBase.startsWith("REPLACE_WITH_")) {
            try {
                return new URL(path, configuredBase.endsWith("/") ? configuredBase : `${configuredBase}/`).toString();
            } catch (_) {}
        }
        return path;
    }

    function saveSettings() {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (_) {}
        if (!settings.competitionMode) clearCompetitionLaunchIntent();
        applyHUDVisibility();
        updateSettingsControls();
        requestTick();
    }

    function saveState() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (_) {}
        renderHUD();
    }

    function resetRoundTimer() {
        currentRoundId = "";
        currentRoundNumber = 0;
        currentRoundStartedAtMs = 0;
        currentRoundExpired = false;
        removeTimerElement();
    }

    async function fetchGeoDuelsSession() {
        if (sessionCache) return sessionCache;
        if (sessionPromise) return sessionPromise;
        sessionPromise = targetWin.fetch(getApiURL("/v1/auth/session"), {
            credentials: "include",
            cache: "no-store"
        }).then(async (response) => {
            if (!response.ok || response.status === 204) return null;
            let raw = null;
            try {
                raw = await response.json();
            } catch (_) {
                return null;
            }
            const nestedUser = raw?.user || raw?.session?.user || raw?.data?.user || null;
            const userId = String(
                raw?.userId || raw?.user_id || nestedUser?.id || nestedUser?.userId || raw?.data?.userId || ""
            ).trim();
            const accessToken = String(
                raw?.accessToken || raw?.access_token || raw?.session?.accessToken || raw?.session?.access_token || ""
            ).trim();
            const displayName = String(
                raw?.displayName || raw?.display_name || nestedUser?.display_name || nestedUser?.displayName || nestedUser?.username || raw?.profile?.displayName || nestedUser?.email || raw?.email || ""
            ).trim();
            const rawAvatar = raw?.avatarUrl || raw?.avatar_url || raw?.avatar || raw?.image || raw?.picture
                || raw?.profile?.avatarUrl || raw?.profile?.avatar_url || raw?.profile?.avatar || raw?.profile?.image
                || nestedUser?.avatarUrl || nestedUser?.avatar_url || nestedUser?.avatar || nestedUser?.image
                || nestedUser?.picture || nestedUser?.user_metadata?.avatar_url || nestedUser?.user_metadata?.avatarUrl
                || nestedUser?.user_metadata?.picture || "";
            let avatarUrl = String(rawAvatar || "").trim();
            try {
                if (avatarUrl.startsWith("//")) avatarUrl = `${location.protocol}${avatarUrl}`;
                else if (avatarUrl.startsWith("/")) avatarUrl = new URL(avatarUrl, location.origin).href;
            } catch (_) {}
            sessionCache = { userId, accessToken, displayName, avatarUrl };
            return sessionCache;
        }).catch(() => null).finally(() => {
            sessionPromise = null;
        });
        return sessionPromise;
    }

    const LEADERBOARD_ID_NAMESPACE = "geoduels-country-streak-recovery-v1";

    function normalizeLeaderboardName(value) {
        return String(value || "")
            .normalize("NFKC")
            .trim()
            .replace(/\s+/g, " ")
            .replace(/[^\p{L}\p{N} _-]/gu, "")
            .slice(0, 48);
    }

    function normalizeRecoveryId(value) {
        return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 32);
    }

    function generateRecoveryId() {
        const bytes = new Uint8Array(12);
        targetWin.crypto.getRandomValues(bytes);
        const compact = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join("");
        return compact.match(/.{1,4}/g).join("-");
    }

    function getConfiguredLeaderboardName() {
        const input = document.getElementById("gd-streak-account-name");
        return normalizeLeaderboardName(input?.value || settings.leaderboardAccountName || settings.leaderboardDisplayName);
    }

    function readRememberedLeaderboardAccount() {
        const candidates = [];
        try {
            candidates.push(targetWin.sessionStorage.getItem(LEADERBOARD_ACCOUNT_SESSION_KEY));
        } catch (_) {}
        try {
            candidates.push(targetWin.localStorage.getItem(LEADERBOARD_ACCOUNT_STORAGE_KEY));
        } catch (_) {}
        for (const raw of candidates) {
            try {
                const saved = JSON.parse(raw || "null");
                const displayName = normalizeLeaderboardName(saved?.displayName || "");
                const accountId = String(saved?.accountId || "").trim();
                if (displayName && /^recovery_[0-9a-f]{64}$/i.test(accountId)) {
                    return { displayName, accountId, recoveryId: "" };
                }
            } catch (_) {}
        }
        return null;
    }

    function saveRememberedLeaderboardAccount(name, accountId) {
        const saved = JSON.stringify({
            displayName: normalizeLeaderboardName(name),
            accountId: String(accountId || "")
        });
        try {
            targetWin.sessionStorage.setItem(LEADERBOARD_ACCOUNT_SESSION_KEY, saved);
        } catch (_) {}
        try {
            targetWin.localStorage.setItem(LEADERBOARD_ACCOUNT_STORAGE_KEY, saved);
        } catch (_) {}
    }

    function clearRememberedLeaderboardAccount() {
        try {
            targetWin.sessionStorage.removeItem(LEADERBOARD_ACCOUNT_SESSION_KEY);
        } catch (_) {}
        try {
            targetWin.localStorage.removeItem(LEADERBOARD_ACCOUNT_STORAGE_KEY);
        } catch (_) {}
    }

    async function deriveLeaderboardAccountId(name, recoveryId) {
        const normalizedName = normalizeLeaderboardName(name).toLowerCase();
        const normalizedRecovery = normalizeRecoveryId(recoveryId);
        const hash = await sha256(`${LEADERBOARD_ID_NAMESPACE}|${normalizedName}|${normalizedRecovery}`);
        return `recovery_${hash}`;
    }

    async function leaderboardQuery(params) {
        const query = new URLSearchParams(params).toString();
        const response = await targetWin.fetch(`${SUPABASE_URL}/rest/v1/country_streak_leaderboard?${query}`, {
            headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
            cache: "no-store"
        });
        if (!response.ok) throw new Error(`Leaderboard account lookup failed (${response.status})`);
        return response.json();
    }

    async function leaderboardNameExists(name) {
        const rows = await leaderboardQuery({ select: "rank", display_name: `eq.${name}`, limit: "1" });
        return Array.isArray(rows) && rows.length > 0;
    }

    async function leaderboardAccountExists(name, accountId) {
        const rows = await leaderboardQuery({
            select: "rank",
            display_name: `eq.${name}`,
            user_id: `eq.${accountId}`,
            limit: "1"
        });
        return Array.isArray(rows) && rows.length > 0;
    }

    async function leaderboardUserIdExists(accountId) {
        const rows = await leaderboardQuery({
            select: "rank",
            user_id: `eq.${accountId}`,
            limit: "1"
        });
        return Array.isArray(rows) && rows.length > 0;
    }

    async function createUniqueLeaderboardAccount(name) {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const recoveryId = generateRecoveryId();
            const accountId = await deriveLeaderboardAccountId(name, recoveryId);
            if (!(await leaderboardUserIdExists(accountId))) return { accountId, recoveryId };
        }
        throw new Error("Could not generate a unique leaderboard account ID. Please try again.");
    }

    function activateLeaderboardAccount(name, accountId, recoveryId = "") {
        leaderboardAccount = { displayName: name, accountId, recoveryId };
        saveRememberedLeaderboardAccount(name, accountId);

        settings.leaderboardEnabled = true;
        settings.leaderboardAccountName = name;
        settings.leaderboardDisplayName = name;
        saveSettings();
    }

    async function ensureLeaderboardIdentity() {
        if (leaderboardAccount?.accountId) return true;
        if (leaderboardIdentityPromise) return leaderboardIdentityPromise;
        const rememberedAccount = readRememberedLeaderboardAccount();
        const configuredName = getConfiguredLeaderboardName();
        if (rememberedAccount && (!configuredName || rememberedAccount.displayName === configuredName)) {
            leaderboardAccount = rememberedAccount;
            saveRememberedLeaderboardAccount(rememberedAccount.displayName, rememberedAccount.accountId);
            settings.leaderboardEnabled = true;
            settings.leaderboardAccountName = rememberedAccount.displayName;
            settings.leaderboardDisplayName = rememberedAccount.displayName;
            saveSettings();
            return true;
        }
        leaderboardIdentityPromise = (async () => {
            let accountName = configuredName;
            if (!accountName) {
                const nameResult = await showToastCard({
                    title: "Set up Country Streak",
                    message: "Choose the visible name used by the Country Streak leaderboard. Your real GeoDuels User ID is never used.",
                    input: { placeholder: "Leaderboard name", maxLength: 48 },
                    buttons: [
                        { label: "CONTINUE", value: "continue", kind: "primary" },
                        { label: "CANCEL", value: "cancel" }
                    ],
                    tone: "info"
                });
                accountName = normalizeLeaderboardName(nameResult?.value || "");
            }
            if (!accountName) return false;

            let nameExists = false;
            try {
                nameExists = await leaderboardNameExists(accountName);
            } catch (error) {
                showToastNotice(`Unable to check the leaderboard account name: ${String(error?.message || error)}`, { title: "Leaderboard unavailable", tone: "error" });
                return false;
            }

            let recoveryId = "";
            if (nameExists) {
                const recoveryResult = await showToastCard({
                    title: "Existing leaderboard name",
                    message: `The name “${accountName}” already exists. Enter its Recovery ID to use that account.`,
                    input: { placeholder: "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX", maxLength: 32 },
                    buttons: [
                        { label: "USE THIS ACCOUNT", value: "use", kind: "primary" },
                        { label: "CANCEL", value: "cancel" }
                    ],
                    tone: "warning"
                });
                recoveryId = normalizeRecoveryId(recoveryResult?.value || "");
                if (recoveryId) {
                    const existingAccountId = await deriveLeaderboardAccountId(accountName, recoveryId);
                    if (await leaderboardAccountExists(accountName, existingAccountId)) {
                        activateLeaderboardAccount(accountName, existingAccountId, recoveryId);
                        showToastNotice(`Signed in as “${accountName}”.`, { title: "Leaderboard account ready", tone: "success" });
                        return true;
                    }
                }
                const createDuplicate = await showToastCard({
                    title: "Recovery ID did not match",
                    message: "No new account has been created. You may create a separate anonymous account with the same visible name.",
                    buttons: [
                        { label: "CREATE NEW ACCOUNT", value: "create", kind: "primary" },
                        { label: "CANCEL", value: "cancel" }
                    ],
                    tone: "warning"
                });
                if (createDuplicate?.action !== "create") return false;
            }

            let createdAccount;
            try {
                createdAccount = await createUniqueLeaderboardAccount(accountName);
            } catch (error) {
                showToastNotice(`Unable to create a unique leaderboard account: ${String(error?.message || error)}`, { title: "Account creation failed", tone: "error" });
                return false;
            }
            activateLeaderboardAccount(accountName, createdAccount.accountId, createdAccount.recoveryId);
            await showToastCard({
                title: "Leaderboard account created",
                message: `Account name: ${accountName}\nYour Recovery ID is shown below. Save it somewhere safe; it is not stored by this script or in cookies.`,
                input: { value: createdAccount.recoveryId, maxLength: 32 },
                buttons: [
                    { label: "COPY RECOVERY ID", value: "copy", kind: "primary", keepOpen: true, onClick: (value) => {
                        try { targetWin.navigator.clipboard?.writeText(value); } catch (_) {}
                        showToastNotice("Recovery ID copied when the browser permits clipboard access.", { title: "Copied", tone: "success", duration: 2600 });
                    } },
                    { label: "DONE", value: "done" }
                ],
                tone: "success"
            });
            return true;
        })();
        try {
            return await leaderboardIdentityPromise;
        } finally {
            leaderboardIdentityPromise = null;
        }
    }

    async function ensureUnifiedCountryStreakSetup() {
        // Country Streak play and Streaks leaderboard are one account/setup
        // surface. The shared identity promise prevents duplicate toast cards
        // when two React click/render paths arrive at the same time.
        const ready = await ensureLeaderboardIdentity();
        if (ready && !settings.enabled) {
            settings.enabled = true;
            saveSettings();
        }
        return ready;
    }

    function getSubmittedCompetitionBest(id) {
        if (!id) return 0;
        let best = 0;
        for (const value of state.submittedCompetitionMatches) {
            const raw = String(value || "");
            const separator = raw.lastIndexOf("::");
            const submittedId = separator >= 0 ? raw.slice(0, separator) : raw;
            if (submittedId !== id) continue;
            const submittedBest = separator >= 0 ? Number(raw.slice(separator + 2)) : 0;
            best = Math.max(best, Number.isFinite(submittedBest) ? submittedBest : 0);
        }
        return best;
    }

    function isSubmittedCompetitionMatch(id, bestStreak = Number.POSITIVE_INFINITY) {
        return getSubmittedCompetitionBest(id) >= Math.max(0, Number(bestStreak) || 0);
    }

    function rememberSubmittedCompetitionMatch(id, bestStreak = 0) {
        if (!id) return;
        const best = Math.max(0, Number(bestStreak) || 0);
        if (isSubmittedCompetitionMatch(id, best)) return;
        state.submittedCompetitionMatches = state.submittedCompetitionMatches.filter((value) => {
            const raw = String(value || "");
            const separator = raw.lastIndexOf("::");
            const submittedId = separator >= 0 ? raw.slice(0, separator) : raw;
            return submittedId !== id;
        });
        state.submittedCompetitionMatches.push(`${id}::${best}`);
        state.submittedCompetitionMatches = state.submittedCompetitionMatches.slice(-50);
        saveState();
    }

    function resetMatchTracking(nextMatchId) {
        const normalizedMatchId = typeof nextMatchId === "string" ? nextMatchId : String(nextMatchId || "");
        if (!normalizedMatchId) return;

        // A reload starts with matchId unset. If the persisted active match is the
        // same match, keep its events and streak so the last snapshot is not
        // counted a second time.
        if (!matchId && state.activeMatchId === normalizedMatchId) {
            matchId = normalizedMatchId;
            roundIndex = Math.max(roundIndex, ...state.activeEvents.map((event) => event.roundNumber));
            latestRoundNumber = Math.max(latestRoundNumber, roundIndex);
            return;
        }

        if (!matchId || matchId !== normalizedMatchId) {
            if (countryStreakFailureTransitionLock && countryStreakFailureMatchId && countryStreakFailureMatchId !== normalizedMatchId) {
                countryStreakFailureTransitionLock = false;
                countryStreakFailureMatchId = "";
                restoreFailureTransitionHiddenElements();
            }
            const previousMatchId = matchId;
            if (previousMatchId && state.activeMatchId === previousMatchId && isCompetitionMode() && state.activeEvents.length) {
                const snapshot = {
                    activeMatchStartedAtMs: state.activeMatchStartedAtMs,
                    activeStreakBefore: state.activeStreakBefore,
                    activeBestStreakBefore: state.activeBestStreakBefore,
                    activeCompetitionBestBefore: state.activeCompetitionBestBefore,
                    competitionBestStreak: state.competitionBestStreak,
                    activeEvents: state.activeEvents.map((event) => ({ ...event })),
                    currentStreak: state.currentStreak,
                    bestStreak: state.bestStreak,
                    totalCorrect: state.totalCorrect,
                    totalGuessed: state.totalGuessed,
                    lastLoss: state.lastLoss ? { ...state.lastLoss } : null
                };
                void submitCompetitionMatch(previousMatchId, false, snapshot);
            }
            roundIndex = 0;
            latestRoundNumber = 0;
            latestRoundCount = 0;
            latestMatchConfig = null;
            latestSnapshot = null;
            matchEnded = false;
            nextMatchStartPromise = null;
            evaluationInFlight = null;
            lastRoundSummary = null;
            processedResultKeys.clear();
            removeCountryStreakStageOverlay();
            resetRoundTimer();
            state.lastLoss = null;
            state.activeMatchId = normalizedMatchId;
            state.activeMatchStartedAtMs = Date.now();
            state.activeRoundId = "";
            state.activeRoundStartedAtMs = 0;
            state.activeStreakBefore = state.currentStreak;
            state.activeBestStreakBefore = state.bestStreak;
            state.activeCompetitionBestBefore = state.competitionBestStreak;
            state.activeEvents = [];
            finalizedGuessByRound.clear();
            latestFinalizedGuessByMatch.clear();
            seenRoundKeys.clear();
            processedResultKeys.clear();
            lastRoundSummary = null;
            removeGameOverOverlay();
            removeCountryStreakStageOverlay();
            saveState();
        }
        matchId = normalizedMatchId;
    }

    function startNewActiveMatchIfNeeded() {
        if (!matchId || state.activeMatchId === matchId) return;
        state.activeMatchId = matchId;
        state.activeMatchStartedAtMs = Date.now();
        state.activeRoundId = "";
        state.activeRoundStartedAtMs = 0;
        state.activeStreakBefore = state.currentStreak;
        state.activeBestStreakBefore = state.bestStreak;
        state.activeCompetitionBestBefore = state.competitionBestStreak;
        state.activeEvents = [];
        seenRoundKeys.clear();
        processedResultKeys.clear();
        lastRoundSummary = null;
        removeCountryStreakStageOverlay();
        saveState();
    }

    async function sha256(value) {
        try {
            const data = new TextEncoder().encode(value);
            const digest = await crypto.subtle.digest("SHA-256", data);
            return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
        } catch (_) {
            let hash = 2166136261;
            for (let index = 0; index < value.length; index += 1) {
                hash ^= value.charCodeAt(index);
                hash = Math.imul(hash, 16777619);
            }
            return `${hash.toString(16).padStart(8, "0")}${"0".repeat(56)}`;
        }
    }

    function getPersonalBest(sourceState = state) {
        return Math.max(
            0,
            Number(sourceState.competitionBestStreak) || 0,
            Number(sourceState.currentStreak) || 0,
            Number(sourceState.lastLoss?.finalStreak) || 0
        );
    }

    function updatePersonalBest(candidate) {
        const streak = Math.max(0, Number(candidate) || 0);
        const previousBest = Math.max(0, Number(state.bestStreak) || 0);
        if (streak <= previousBest) return false;
        state.bestStreak = streak;
        return true;
    }

    function updateCompetitionBest(candidate) {
        const streak = Math.max(0, Number(candidate) || 0);
        const previousBest = Math.max(0, Number(state.competitionBestStreak) || 0);
        if (streak <= previousBest) return false;
        state.competitionBestStreak = streak;
        return true;
    }

    function hasNewPersonalBest(sourceState = state) {
        return getPersonalBest(sourceState) > Math.max(0, Number(sourceState.activeCompetitionBestBefore) || 0);
    }

    function getDisplayedBestStreak() {
        return settings.competitionMode ? state.competitionBestStreak : state.bestStreak;
    }

    async function appendRoundEvent({ roundNumber, roundId, actual, guessed, isCorrect, startedAtMs, resultAtMs }) {
        if (!matchId || !settings.enabled || !isInSingleplayer()) return;
        startNewActiveMatchIfNeeded();
        const normalizedRoundNumber = Math.max(1, Number(roundNumber) || 1);
        const eventRoundId = typeof roundId === "string" ? roundId : "";
        const duplicateKey = `${eventRoundId || "round"}:${normalizedRoundNumber}:${Number(resultAtMs) || Date.now()}`;
        if (state.activeEvents.some((event) => event.roundId === eventRoundId && event.roundNumber === normalizedRoundNumber)) return;
        if (seenRoundKeys.has(duplicateKey)) return;
        seenRoundKeys.add(duplicateKey);

        const started = Number.isFinite(Number(startedAtMs)) ? Number(startedAtMs) : Date.now();
        const finished = Number.isFinite(Number(resultAtMs)) ? Number(resultAtMs) : Date.now();
        const previousHash = state.activeEvents.at(-1)?.eventHash || "GENESIS";
        const event = {
            roundNumber: normalizedRoundNumber,
            roundId: eventRoundId,
            actualCountryCode: String(actual?.code || "").toUpperCase(),
            guessedCountryCode: String(guessed?.code || "").toUpperCase(),
            isCorrect: isCorrect === true,
            startedAtMs: started,
            resultAtMs: finished,
            elapsedMs: Math.max(0, Math.min(86400000, finished - started)),
            previousHash,
            eventHash: ""
        };
        const canonical = [
            previousHash,
            matchId,
            leaderboardAccount?.accountId || "anonymous",
            event.roundNumber,
            event.roundId,
            event.actualCountryCode,
            event.guessedCountryCode,
            event.isCorrect ? "1" : "0",
            event.startedAtMs,
            event.resultAtMs,
            event.elapsedMs
        ].join("|");
        event.eventHash = await sha256(canonical);
        state.activeEvents.push(event);
        state.activeEvents = state.activeEvents.slice(-10000);
        saveState();
    }

    function buildCompetitionPayload(targetMatchId, _session, sourceState = state) {
        if (!targetMatchId || !sourceState.activeEvents?.length || !leaderboardAccount?.accountId) return null;
        const accountId = leaderboardAccount?.accountId || "";
        if (!accountId) return null;
        const eventId = `${accountId}:${targetMatchId}`;
        const personalBest = getPersonalBest(sourceState);
        if (isSubmittedCompetitionMatch(eventId, personalBest)) return null;
        const events = sourceState.activeEvents.map((event) => ({ ...event }));
        const lastEvent = events.at(-1);
        return {
            p_match_id: targetMatchId,
            p_user_id: accountId,
            p_display_name: leaderboardAccount.displayName,
            p_round_events: events,
            p_streak_before: Math.max(0, Number(sourceState.activeStreakBefore) || 0),
            p_final_streak: Math.max(0, sourceState.lastLoss ? sourceState.lastLoss.finalStreak : Number(sourceState.currentStreak) || 0),
            p_best_streak: personalBest,
            p_total_correct: events.filter((event) => event.isCorrect).length,
            p_total_guesses: events.length,
            p_client_started_at_ms: sourceState.activeMatchStartedAtMs || events[0].startedAtMs,
            p_client_finished_at_ms: lastEvent.resultAtMs,
            p_chain_hash: lastEvent.eventHash
        };
    }

    function submitCompetitionWhenReady(targetMatchId = matchId) {
        if (!isCompetitionMode() || !state.activeEvents.length) return;
        if (evaluationInFlight?.promise) {
            void evaluationInFlight.promise.finally(() => submitCompetitionMatch(targetMatchId, false));
        } else {
            void submitCompetitionMatch(targetMatchId, false);
        }
    }

    let lastSubmissionError = "";

    async function submitCompetitionMatch(targetMatchId = matchId, showErrors = false, sourceState = state) {
        if (!isCompetitionMode() || !targetMatchId || !hasNewPersonalBest(sourceState)) return false;
        if (!leaderboardAccount?.accountId) {
            const identityReady = await ensureLeaderboardIdentity();
            if (!identityReady || !leaderboardAccount?.accountId) return;
        }
        const payload = buildCompetitionPayload(targetMatchId, null, sourceState);
        if (!payload) return;
        const submissionKey = `${leaderboardAccount.accountId}:${targetMatchId}`;
        const pendingSubmission = pendingSubmissionPromises.get(submissionKey);
        if (pendingSubmission) {
            return pendingSubmission.finally(() => {
                if (sourceState === state && isCompetitionMode() && hasNewPersonalBest(state)) {
                    void submitCompetitionMatch(targetMatchId, false, state);
                }
            });
        }

        const promise = targetWin.fetch(`${SUPABASE_URL}/rest/v1/rpc/submit_country_streak`, {
            method: "POST",
            headers: {
                apikey: SUPABASE_PUBLISHABLE_KEY,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload),
            cache: "no-store",
            keepalive: true
        }).then(async (response) => {
            if (!response.ok) {
                const text = await response.text().catch(() => "");
                throw new Error(`Leaderboard submission failed (${response.status}) ${text.slice(0, 180)}`);
            }
            rememberSubmittedCompetitionMatch(submissionKey, payload.p_best_streak);
            lastSubmissionError = "";
            return true;
        }).catch((error) => {
            const message = String(error?.message || error || "Unknown submission error");
            lastSubmissionError = message;
            console.error("[GeoDuels Country Streak] competition submission failed", error);
            if (showErrors) {
                const authRequired = /authentication required|invalid_token|wrong key type/i.test(message);
                showToastNotice(authRequired
                    ? "Your new Country Streak record was saved locally, but the leaderboard RPC requires a Supabase Auth JWT. The GeoDuels login token cannot authorize this database write."
                    : `Your new Country Streak record was saved locally, but the online submission failed: ${message}`, {
                    title: "Leaderboard submission failed",
                    tone: "error",
                    duration: 8000
                });
            }
            return false;
        }).finally(() => {
            pendingSubmissionPromises.delete(submissionKey);
        });
        pendingSubmissionPromises.set(submissionKey, promise);
        return promise;
    }

    function countryNameFromCode(code) {
        const normalized = String(code || "").trim().toUpperCase();
        if (!normalized) return "";
        try {
            const displayName = new Intl.DisplayNames(["en-US"], { type: "region" }).of(normalized);
            if (displayName && displayName !== normalized) return displayName;
        } catch (_) {}
        return normalized;
    }

    async function requestReverseGeocodeJSON(url, headers = {}) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== "undefined") {
                GM_xmlhttpRequest({
                    method: "GET",
                    url,
                    headers,
                    timeout: REVERSE_GEOCODE_TIMEOUT_MS,
                    onload: (response) => {
                        if (Number(response.status) >= 400) {
                            reject(new Error(`Reverse geocode failed (${response.status})`));
                            return;
                        }
                        try {
                            resolve(JSON.parse(response.responseText));
                        } catch (error) {
                            reject(error);
                        }
                    },
                    onerror: reject,
                    ontimeout: reject
                });
                return;
            }
            targetWin.fetch(url, { headers }).then((response) => {
                if (!response.ok) throw new Error(`Reverse geocode failed (${response.status})`);
                return response.json();
            }).then(resolve).catch(reject);
        });
    }

    function countryResultFromBigData(data) {
        const code = String(data?.countryCode || data?.country_code || "").trim().toUpperCase();
        const name = String(data?.countryName || data?.country_name || "").trim()
            || countryNameFromCode(code)
            || String(data?.locality || data?.city || data?.principalSubdivision || "").trim();
        return { name, code };
    }

    function normalizeMarineName(value) {
        return String(value || "")
            .replace(/\s+/g, " ")
            .replace(/\s*\([^)]*\)\s*$/, "")
            .trim();
    }

    function marineCodeFromName(name) {
        const normalized = normalizeMarineName(name).toUpperCase();
        return normalized ? `OCEAN:${normalized}` : "";
    }

    function countryResultFromNominatim(data) {
        const address = data?.address && typeof data.address === "object" ? data.address : {};
        const code = String(address.country_code || data?.country_code || "").trim().toUpperCase();
        if (code) {
            const countryName = String(address.country || "").trim() || countryNameFromCode(code);
            return { name: countryName, code };
        }
        const marineName = normalizeMarineName(
            address.ocean || address.sea || address.water || data?.ocean || data?.sea
            || ((/ocean|sea|gulf|bay|strait|water|coast/i.test(String(data?.type || "")) || /ocean|sea|gulf|bay|strait/i.test(String(data?.name || "")))
                ? (data?.name || data?.display_name?.split(",")?.[0] || "")
                : "")
        );
        if (marineName) return { name: marineName, code: marineCodeFromName(marineName) };
        return { name: "", code: "" };
    }

    function countryResultFromMarineRegions(data) {
        const rows = Array.isArray(data) ? data : [];
        const candidate = rows.find((row) => {
            const placeType = String(row?.placeType || "").toLowerCase();
            const name = String(row?.preferredGazetteerName || "").toLowerCase();
            return /ocean|sea|gulf|bay|basin|marine|pelagic/.test(placeType) || /ocean|sea|gulf|bay/.test(name);
        }) || rows.find((row) => row?.preferredGazetteerName);
        const name = normalizeMarineName(candidate?.preferredGazetteerName || candidate?.name || "");
        if (!name) return { name: "", code: "" };
        return { name, code: marineCodeFromName(name) };
    }

    async function fetchCountry(lat, lng) {
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { name: "No guess", code: "" };
        const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
        if (geoCache.has(key)) return geoCache.get(key);
        const primaryUrl = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`;
        try {
            const primary = countryResultFromBigData(await requestReverseGeocodeJSON(primaryUrl));
            if (primary.code) {
                geoCache.set(key, primary);
                return primary;
            }
        } catch (_) {}
        try {
            const fallbackUrl = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=3&addressdetails=1&accept-language=en`;
            const fallback = countryResultFromNominatim(await requestReverseGeocodeJSON(fallbackUrl, { "Accept-Language": "en" }));
            if (fallback.code || fallback.name) {
                geoCache.set(key, fallback);
                return fallback;
            }
        } catch (_) {}
        try {
            const marineUrl = `https://www.marineregions.org/rest/getGazetteerRecordsByLatLong.json/${encodeURIComponent(lat)}/${encodeURIComponent(lng)}/`;
            const marine = countryResultFromMarineRegions(await requestReverseGeocodeJSON(marineUrl, { "Accept-Language": "en" }));
            if (marine.code || marine.name) {
                geoCache.set(key, marine);
                return marine;
            }
        } catch (_) {}
        return { name: "Location unavailable", code: "" };
    }

    function recordLoss(actual, guessed, roundNumber) {
        const finalStreak = Math.max(0, Number(state.currentStreak) || 0);
        const createdNewPersonalBest = updatePersonalBest(finalStreak);
        const createdNewCompetitionBest = isCompetitionMode() && updateCompetitionBest(finalStreak);
        state.lastStreak = finalStreak;
        state.currentStreak = 0;
        countryStreakFailureTransitionLock = true;
        countryStreakFailureMatchId = String(matchId || "");
        state.lastLoss = {
            finalStreak,
            guessedCountry: guessed.name || "No guess",
            actualCountry: actual.name || "Unknown country",
            round: Math.max(1, Number(roundNumber) || 1)
        };
        // This is called after the country evaluation already confirmed a
        // singleplayer result. Paint the custom failure page immediately;
        // requestTick may still be waiting for React hydration.
        isSingleplayer = true;
        saveState();
        repairGameOverOverlayNow();
        if (failureUiRepairTimer) targetWin.clearTimeout(failureUiRepairTimer);
        let repairAttempts = 0;
        const repair = () => {
            if (!state.lastLoss || !settings.enabled || !isInSingleplayer()) {
                failureUiRepairTimer = null;
                return;
            }
            repairGameOverOverlayNow();
            repairAttempts += 1;
            if (repairAttempts < 40) failureUiRepairTimer = targetWin.setTimeout(repair, 50);
            else failureUiRepairTimer = null;
        };
        failureUiRepairTimer = targetWin.setTimeout(repair, 0);
        requestTick();
        if (createdNewCompetitionBest || isCompetitionMode()) void submitCompetitionMatch(matchId, createdNewCompetitionBest);
    }

    async function evaluate(actualCoords, guessCoords, roundNumber, roundId, startedAtMs, resultAtMs) {
        if (!settings.enabled || !isInSingleplayer()) return;
        const actualLat = Number(actualCoords?.lat);
        const actualLng = Number(actualCoords?.lng);
        const round = Math.max(1, Number(roundNumber) || 1);
        const key = `${matchId || "sp"}:${roundId || "round"}:${round}:${actualLat.toFixed(3)}:${actualLng.toFixed(3)}`;
        if (seenRoundKeys.has(key) || state.activeEvents.some((event) => event.roundId === (roundId || "") && event.roundNumber === round)) return;
        seenRoundKeys.add(key);

        const [actual, guessed] = await Promise.all([
            fetchCountry(actualLat, actualLng),
            guessCoords
                ? fetchCountry(Number(guessCoords.lat), Number(guessCoords.lng))
                : Promise.resolve({ name: "No guess", code: "" })
        ]);
        const isCorrect = Boolean(actual.code && guessed.code && actual.code === guessed.code);
        state.totalGuessed += 1;
        await appendRoundEvent({ roundNumber: round, roundId: roundId || "", actual, guessed, isCorrect, startedAtMs, resultAtMs });
        if (isCorrect) {
            state.currentStreak += 1;
            state.totalCorrect += 1;
            const createdNewPersonalBest = updatePersonalBest(state.currentStreak);
            const createdNewCompetitionBest = isCompetitionMode() && updateCompetitionBest(state.currentStreak);
            state.lastLoss = null;
            countryStreakFailureTransitionLock = false;
            countryStreakFailureMatchId = "";
            setFailureLockClass(false);
            restoreFailureTransitionHiddenElements();
            saveState();
            if (createdNewCompetitionBest) void submitCompetitionMatch(matchId, true);
        } else {
            recordLoss(actual, guessed, round);
        }
        requestTick();
    }

    function getReplayConfig() {
        const config = {};
        if (latestMatchConfig && typeof latestMatchConfig === "object") {
            for (const key of ["ruleset", "streetNames", "mapId", "mapName", "mapKey", "roundTimerMode", "roundTimeLimitMs", "pressureTimeLimitMs"]) {
                if (latestMatchConfig[key] !== undefined) config[key] = latestMatchConfig[key];
            }
        }
        if (isCompetitionMode()) {
            config.ruleset = COMPETITION_RULESET;
            config.streetNames = COMPETITION_STREET_NAMES;
        }
        return Object.keys(config).length ? config : undefined;
    }


    function hasPendingSubmissionForMatch(targetMatchId) {
        return Array.from(pendingSubmissionPromises.keys()).some((key) => key.endsWith(`:${targetMatchId}`));
    }

    async function waitForPendingSubmissions(targetMatchId) {
        const identityPromise = leaderboardIdentityPromise;
        if (identityPromise) await Promise.allSettled([identityPromise]);
        const pending = Array.from(pendingSubmissionPromises.entries())
            .filter(([key]) => key.endsWith(`:${targetMatchId}`))
            .map(([, promise]) => promise);
        if (pending.length) await Promise.allSettled(pending);
    }

    async function startOfficialSingleplayerDirect(matchConfig) {
        const session = await fetchGeoDuelsSession();
        if (!session) throw new Error("Official session unavailable");
        const headers = { "Content-Type": "application/json" };
        if (session.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;
        const response = await targetWin.fetch(getApiURL("/v1/singleplayer/session"), {
            method: "POST",
            credentials: "include",
            headers,
            body: JSON.stringify(matchConfig || {})
        });
        if (!response.ok) throw new Error("Official singleplayer unavailable");
        const data = await response.json();
        const assignment = {
            matchId: String(data?.matchId || ""),
            mode: String(data?.mode || ""),
            ticket: String(data?.ticket || ""),
            node: String(data?.node || ""),
            wsPath: String(data?.wsPath || "")
        };
        if (!assignment.matchId) throw new Error("Official singleplayer returned no match ID");
        return assignment;
    }

    function prepareFreshCountryStreakMatch() {
        matchId = null;
        currentRoundId = "";
        currentRoundNumber = 0;
        currentRoundStartedAtMs = 0;
        currentRoundExpired = false;
        latestSnapshot = null;
        pendingInitialLiveSnapshot = null;
        latestMatchConfig = null;
        latestRoundNumber = 0;
        latestRoundCount = 0;
        roundIndex = 0;
        matchEnded = false;
        evaluationInFlight = null;
        countryStreakFailureTransitionLock = false;
        countryStreakFailureMatchId = "";
        gameOverRevealRequested = false;
        setFailureLockClass(false);
        restoreFailureTransitionHiddenElements();
        initialTimerSyncDone = false;
        resetRoundTimer();
        removeGameOverOverlay();
        state.lastLoss = null;
        state.activeMatchId = "";
        state.activeMatchStartedAtMs = 0;
        state.activeRoundId = "";
        state.activeRoundStartedAtMs = 0;
        state.activeStreakBefore = Math.max(0, Number(state.currentStreak) || 0);
        state.activeBestStreakBefore = Math.max(0, Number(state.bestStreak) || 0);
        state.activeCompetitionBestBefore = Math.max(0, Number(state.competitionBestStreak) || 0);
        state.activeEvents = [];
        seenRoundKeys.clear();
        processedResultKeys.clear();
        lastRoundSummary = null;
        targetWin.__GD_LAST_GUESS__ = null;
        removeCountryStreakStageOverlay();
        saveState();
    }

    // Remove only DOM left by an older installed version; v29.4 never creates it.
    function removeCountryStreakLoadingOverlay() {
        document.getElementById("gd-country-streak-loading-overlay")?.remove();
    }

    function isCountryStreakFifthRoundSuccess() {
        // latestRoundNumber also advances when round 5 merely starts. Only
        // completed result records may unlock the next-round control.
        const latestResult = getLatestRoundResult(latestSnapshot);
        const latestResultRound = Number(latestResult?.roundNumber || latestResult?.round || 0);
        const hasCompletedFifthResult = latestResultRound >= 5 && Boolean(latestResult?.actualLocation);
        return !state.lastLoss && (
            Number(latestRoundCount || 0) >= 5
            || Number(state.activeEvents?.length || 0) >= 5
            || hasCompletedFifthResult
        );
    }

    function isFinishedMatchSnapshot(snap) {
        const values = [snap?.state, snap?.phase, snap?.roundPhase].map((value) => String(value || "").toLowerCase().replace(/[\s-]+/g, "_"));
        return values.some((value) => ["ended", "complete", "completed", "match_end", "match_ended"].includes(value));
    }

    function findNativeRoundAdvanceButton() {
        return Array.from(document.querySelectorAll("button, a")).find((candidate) => {
            if (gameOverOverlay?.contains(candidate)) return false;
            const label = `${candidate.textContent || ""} ${candidate.getAttribute("title") || ""} ${candidate.getAttribute("aria-label") || ""}`.toLowerCase();
            return /next\s+round/i.test(label);
        }) || null;
    }

    function delayForCountryStreakAdvance(ms) {
        return new Promise((resolve) => targetWin.setTimeout(resolve, ms));
    }

    async function continueExistingCountryStreakRound(button) {
        if (existingRoundAdvancePromise) return existingRoundAdvancePromise;
        const retryPromise = (async () => {
            if (!state.lastLoss) {
                const nativeButton = findNativeRoundAdvanceButton();
                if (nativeButton && !nativeButton.disabled && nativeButton.offsetParent !== null) {
                    nativeButton.dataset.gdCountryStreakAllowNext = "true";
                    nativeButton.dataset.gdAllowNativeNextRound = "true";
                    nativeButton.click();
                    return true;
                }
            }
            if (button) {
                button.disabled = true;
                button.setAttribute("aria-busy", "true");
            }
            for (let attempt = 0; attempt < 50; attempt += 1) {
                if (!state.lastLoss && !isCountryStreakFifthRoundSuccess()) break;
                const latestGuess = getLatestGuess();
                const storedGuess = latestFinalizedGuessByMatch.get(String(matchId || ""));
                let userId = String(sessionCache?.userId || storedGuess?.userId || latestGuess?.userId || "");
                if (!userId && attempt % 4 === 0) {
                    const session = await fetchGeoDuelsSession();
                    userId = String(session?.userId || "");
                }
                if (activeSocket && activeSocket.readyState === WebSocket.OPEN && matchId && userId) {
                    try {
                        activeSocket.send(JSON.stringify({
                            commandId: `${userId}-${Date.now()}-country-streak-round-advance`,
                            type: "round.advance",
                            payload: { userId, matchId },
                            sentAt: Date.now()
                        }));
                        return true;
                    } catch (_) {}
                }
                await delayForCountryStreakAdvance(120);
            }
            if (button) {
                button.disabled = false;
                button.removeAttribute("aria-busy");
            }
            if (isCountryStreakFifthRoundSuccess()) {
                return startFreshSingleplayer(button);
            }
            showToastNotice("The current Country Streak round could not be advanced because the official game connection is still unavailable. Please wait for the result to finish loading and try again.", { title: "Next round unavailable", tone: "error", duration: 7200 });
            return false;
        })();
        existingRoundAdvancePromise = retryPromise.finally(() => {
            existingRoundAdvancePromise = null;
        });
        return existingRoundAdvancePromise;
    }

    async function startFreshSingleplayer(button) {
        // Ordinary failures continue the current native singleplayer match.
        // A fresh native game is allowed only after a successful fifth round.
        const fifthControl = Boolean(button && (button.id === "gd-country-streak-fifth-next" || button.dataset?.gdCountryStreakFifthNext === "true"));
        const hasFiveCompletedRounds = Number(latestRoundCount || 0) >= 5
            || Number(state.activeEvents?.length || 0) >= 5
            || (Number(getLatestRoundResult(latestSnapshot)?.roundNumber || 0) >= 5
                && Boolean(getLatestRoundResult(latestSnapshot)?.actualLocation));
        const fifthSuccessForControl = fifthControl && !state.lastLoss && hasFiveCompletedRounds && getCountryStreakStage(latestSnapshot) === "result";
        if (state.lastLoss || (!isCountryStreakFifthRoundSuccess() && !fifthSuccessForControl)) return continueExistingCountryStreakRound(button);
        if (nextMatchStartPromise) return nextMatchStartPromise;
        const launchRules = getCountryStreakLaunchRules();
        const startPromise = (async () => {
            // The round.advance command is unreliable after the fifth result.
            // Persist the same mode, perform a real homepage navigation, then
            // let the homepage automation click Country Streak and Start.
            removeCountryStreakLoadingOverlay();
            if (button) {
                button.disabled = true;
                button.setAttribute("aria-busy", "true");
                button.style.pointerEvents = "none";
            }
            settings.countryStreakRuleset = launchRules.ruleset;
            settings.countryStreakStreetNames = launchRules.streetNames;
            countryStreakRules = { ...launchRules };
            saveSettings();
            prepareFreshCountryStreakMatch();
            setAutomaticCountryStreakRestart(launchRules);
            setCountryStreakIntent();
            targetWin.location.replace("https://geoduels.io/");
            return true;
        })();
        nextMatchStartPromise = startPromise.catch((error) => {
            console.error("[GeoDuels Country Streak] unable to start the next match", error);
            removeCountryStreakLoadingOverlay();
            showToastNotice(`Unable to start a new Country Streak match: ${String(error?.message || error)}`, { title: "New game failed", tone: "error", duration: 7200 });
            if (button) {
                button.disabled = false;
                button.removeAttribute("aria-busy");
                button.style.pointerEvents = "";
            }
            nextMatchStartPromise = null;
            return false;
        });
        return nextMatchStartPromise;
    }

    function removeGameOverOverlay() {
        gameOverOverlay?.remove();
        gameOverOverlay = null;
        gameOverOverlayKey = "";
    }

    function escapeHTML(value) {
        return String(value ?? "").replace(/[&<>\\"']/g, (character) => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            "\\\"": "&quot;",
            "'": "&#39;"
        })[character]);
    }

    function getCountryStreakStage(snap = latestSnapshot) {
        if (!settings.enabled || !isInSingleplayer() || !snap) return "";
        const normalizePhase = (value) => String(value || "").toLowerCase().replace(/[\s-]+/g, "_");
        const phase = normalizePhase(snap.phase);
        const roundPhase = normalizePhase(snap.roundPhase);
        const hasRoundResult = Boolean(getLatestRoundResult(snap)?.actualLocation);
        if (phase === "round_result" || phase === "roundresult" || roundPhase === "round_result" || roundPhase === "roundresult" || roundPhase === "result" || hasRoundResult && /result/.test(phase)) return "result";
        if (roundPhase === "round_transition" || roundPhase === "roundtransition" || (phase === "live" && (roundPhase === "round_intro" || roundPhase === "roundintro" || roundPhase === "intro" || roundPhase === "prematch_countdown"))) return "preparation";
        return "";
    }

    function getLatestRoundResult(snap = latestSnapshot) {
        if (!snap || typeof snap !== "object") return null;
        return snap.lastRoundResult || snap.roundResult || (Array.isArray(snap.roundResults) ? snap.roundResults[snap.roundResults.length - 1] : null);
    }

    function getResultPlayer(result) {
        const players = result?.players && typeof result.players === "object" ? result.players : {};
        const wantedId = String(sessionCache?.userId || "");
        if (wantedId && players[wantedId]) return players[wantedId];
        const byEmbeddedId = Object.values(players).find((player) => player && String(player.userId || "") === wantedId);
        if (byEmbeddedId) return byEmbeddedId;
        return Object.values(players).find((player) => player && typeof player === "object") || null;
    }

    function haversineDistanceKm(from, to) {
        const lat1 = Number(from?.lat);
        const lng1 = Number(from?.lng);
        const lat2 = Number(to?.lat);
        const lng2 = Number(to?.lng);
        if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return null;
        const toRadians = (value) => value * Math.PI / 180;
        const dLat = toRadians(lat2 - lat1);
        const dLng = toRadians(lng2 - lng1);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
        return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
    }

    function getRoundDistanceKm(result, guess = null) {
        const player = getResultPlayer(result);
        const officialDistance = Number(player?.distanceKm ?? player?.distance_km);
        if (Number.isFinite(officialDistance) && officialDistance >= 0) return officialDistance;
        return haversineDistanceKm(guess || player, result?.actualLocation);
    }

    function getResultRoundNumber(result, snap = latestSnapshot) {
        return Math.max(1, Number(result?.roundNumber || result?.round || result?.roundIndex || snap?.currentRound?.roundNumber || latestRoundNumber || currentRoundNumber || 1) || 1);
    }

    function getStableResultKey(result, snap = latestSnapshot) {
        if (!result?.actualLocation) return "";
        const round = getResultRoundNumber(result, snap);
        const roundId = String(result.roundId || result.id || snap?.lastRoundResult?.roundId || "");
        const actualLat = Number(result.actualLocation.lat);
        const actualLng = Number(result.actualLocation.lng);
        return `${matchId || snap?.matchId || "sp"}:${roundId || "round"}:${round}:${Number.isFinite(actualLat) ? actualLat.toFixed(5) : ""}:${Number.isFinite(actualLng) ? actualLng.toFixed(5) : ""}`;
    }

    function rememberRoundSummary(result, resultKey, guess = null) {
        if (!result || !resultKey) return;
        const distanceKm = getRoundDistanceKm(result, guess);
        lastRoundSummary = {
            key: resultKey,
            matchId: matchId || String(latestSnapshot?.matchId || ""),
            roundNumber: getResultRoundNumber(result),
            distanceKm: Number.isFinite(distanceKm) ? distanceKm : null,
            streak: Math.max(0, Number(state.currentStreak) || 0),
            best: Math.max(0, Number(getDisplayedBestStreak()) || 0)
        };
    }

    function getPreparationCountdownSeconds(snap = latestSnapshot) {
        const endsAt = toTimestampMs(snap?.phaseEndsAt || snap?.roundDeadline || snap?.currentRound?.roundDeadline);
        if (!endsAt) return 0;
        const serverNow = toTimestampMs(snap?.serverUnixMS || snap?.serverUnixMs);
        const now = serverNow > 0 && serverNow <= Date.now() + 1000 ? Date.now() + (serverNow - Date.now()) : Date.now();
        return Math.max(0, Math.ceil((endsAt - now) / 1000));
    }

    function setCountryStreakResultLock(active) {
        const locked = Boolean(active);
        document.documentElement?.classList.toggle("gd-country-streak-result-lock", locked);
        document.body?.classList.toggle("gd-country-streak-result-lock", locked);
    }

    function getNativeRoundResultLayer() {
        return Array.from(document.querySelectorAll("div")).find((candidate) => {
            const className = typeof candidate.className === "string" ? candidate.className : "";
            const tokens = new Set(className.split(/\s+/).filter(Boolean));
            if (!(tokens.has("absolute") && tokens.has("inset-0") && tokens.has("z-20") && tokens.has("pointer-events-none"))) return false;
            const text = (candidate.textContent || "").toLowerCase();
            return Boolean(candidate.querySelector('img[alt="Trophy"]'))
                || /next\s+round|back\s+to\s+(lobby|party)|play\s+again|continue/.test(text)
                || /points/.test(text)
                || (/round/.test(text) && candidate.querySelector('button, a'));
        }) || null;
    }

    function getNativeSingleplayerRoundPointsCards() {
        return Array.from(document.querySelectorAll("div")).filter((candidate) => {
            const className = typeof candidate.className === "string" ? candidate.className : "";
            const tokens = new Set(className.split(/\s+/).filter(Boolean));
            const text = (candidate.textContent || "").toLowerCase();
            return tokens.has("absolute") && tokens.has("right-3") && tokens.has("top-3") && tokens.has("z-30") && text.includes("round") && text.includes("points");
        });
    }

    function getNativeSingleplayerRoundPointsCard() {
        return getNativeSingleplayerRoundPointsCards()[0] || null;
    }

    function hideNativeResultScore() {
        const layer = getNativeRoundResultLayer();
        const scoreNodes = layer ? Array.from(layer.querySelectorAll("div")).filter((candidate) => {
            const className = typeof candidate.className === "string" ? candidate.className : "";
            const text = (candidate.textContent || "").trim();
            return className.includes("text-[clamp") || (/^-?[\d,.]+$/.test(text) && candidate.children.length === 0 && text.length <= 12);
        }) : [];
        for (const scoreNode of scoreNodes) {
            if (!nativeResultOriginalStyles.has(scoreNode)) {
                nativeResultOriginalStyles.set(scoreNode, scoreNode.style.cssText);
                nativeResultStyledElements.add(scoreNode);
            }
            scoreNode.style.setProperty("display", "none", "important");
            scoreNode.style.setProperty("visibility", "hidden", "important");
        }
        for (const pointsCard of getNativeSingleplayerRoundPointsCards()) {
            if (!nativeResultOriginalStyles.has(pointsCard)) {
                nativeResultOriginalStyles.set(pointsCard, pointsCard.style.cssText);
                nativeResultStyledElements.add(pointsCard);
            }
            pointsCard.style.setProperty("display", "none", "important");
            pointsCard.style.setProperty("visibility", "hidden", "important");
        }
    }

    function restoreNativeResultStyles() {
        for (const element of nativeResultStyledElements) {
            if (element && nativeResultOriginalStyles.has(element)) element.style.cssText = nativeResultOriginalStyles.get(element) || "";
        }
        nativeResultStyledElements.clear();
    }

    function getNativeMatchEndLayer() {
        return Array.from(document.querySelectorAll('[class*="app-layer-match-end"]')).find((candidate) => candidate.id !== "gd-game-over-overlay") || null;
    }

    function rememberAndStyleMatchEndElement(element, stylePatch) {
        if (!element) return;
        if (!nativeMatchEndOriginalStyles.has(element)) {
            nativeMatchEndOriginalStyles.set(element, element.style.cssText);
            nativeMatchEndStyledElements.add(element);
        }
        Object.assign(element.style, stylePatch);
    }

    function hideNativeMatchEndRoundAndScore(endLayer) {
        if (!endLayer) return;
        const scoreNode = Array.from(endLayer.querySelectorAll("h1,h2,h3,p,span,div")).find((candidate) => /^\s*[\d,.]+\s*(pts?|points)\s*$/i.test(candidate.textContent || ""));
        if (scoreNode) rememberAndStyleMatchEndElement(scoreNode.closest("h1,h2,h3") || scoreNode, { display: "none" });
        for (const candidate of endLayer.querySelectorAll("[aria-label],[title]")) {
            const label = `${candidate.getAttribute("aria-label") || ""} ${candidate.getAttribute("title") || ""}`;
            if (/^\s*(open\s+)?round\s+\d+/i.test(label)) {
                const marker = candidate.closest('[role="button"]') || candidate;
                rememberAndStyleMatchEndElement(marker, { display: "none" });
            }
        }
    }

    function restoreNativeMatchEndStyles() {
        for (const element of nativeMatchEndStyledElements) {
            if (element && nativeMatchEndOriginalStyles.has(element)) element.style.cssText = nativeMatchEndOriginalStyles.get(element) || "";
        }
        nativeMatchEndStyledElements.clear();
    }

    function removeCountryStreakMatchEndHUD() {
        document.getElementById("gd-country-streak-match-end-hud")?.remove();
        restoreNativeMatchEndStyles();
    }

    function hideNativeEntireMatchEndLayer(endLayer) {
        if (!endLayer) return;
        rememberAndStyleMatchEndElement(endLayer, { display: "none", pointerEvents: "none" });
    }

    function removeCountryStreakFifthNextControl() {
        countryStreakFifthNextControl?.remove();
        document.getElementById("gd-country-streak-fifth-next-control")?.remove();
        document.getElementById("gd-country-streak-loss-review-control")?.remove();
        document.getElementById("gd-country-streak-view-game-over")?.closest("button")?.remove();
        countryStreakFifthNextControl = null;
    }

    function getVisibleCountryStreakControl(button) {
        if (!button) return null;
        const style = targetWin.getComputedStyle ? targetWin.getComputedStyle(button) : null;
        return style?.display !== "none" && style?.visibility !== "hidden" && button.getClientRects().length > 0 ? button : null;
    }

    function findNativeFifthRoundNextButton() {
        const resultLayer = getNativeRoundResultLayer();
        return Array.from(resultLayer?.querySelectorAll("button, a") || []).find((button) => {
            const label = `${button.textContent || ""} ${button.getAttribute("title") || ""} ${button.getAttribute("aria-label") || ""}`.toLowerCase();
            return /(next\s+round|back\s+to\s+(lobby|party)|play\s+again|continue)/i.test(label) && getVisibleCountryStreakControl(button);
        }) || null;
    }

    function installFifthRoundClickFallback() {
        if (fifthRoundClickFallbackInstalled) return;
        fifthRoundClickFallbackInstalled = true;
        document.addEventListener("click", (event) => {
            const target = event.target instanceof Element ? event.target.closest("button, a") : null;
            if (!target || (target.id !== "gd-country-streak-fifth-next" && target.dataset?.gdCountryStreakFifthNext !== "true")) return;
            if (target.dataset.gdCountryStreakFifthCapture === "true") return;
            target.dataset.gdCountryStreakFifthCapture = "true";
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            void Promise.resolve(startFreshSingleplayer(target)).finally(() => {
                targetWin.setTimeout(() => target.dataset.gdCountryStreakFifthCapture = "", 0);
            });
        }, true);
    }

    function patchFifthRoundNextButton(button) {
        if (!button) return false;
        const textNode = button.querySelector("span") || button;
        // React recreates this button after every result. Always refresh its
        // visible label instead of relying on a one-time DOM dataset marker.
        textNode.textContent = state.lastLoss ? "VIEW GAME OVER" : "NEXT ROUND";
        if (textNode.dataset) textNode.dataset.gdCountryStreakFifthLabel = "true";
        if (button.dataset.gdCountryStreakFifthNext !== "true") {
            button.dataset.gdCountryStreakFifthNext = "true";
            button.addEventListener("click", (event) => {
                if (state.lastLoss && !gameOverRevealRequested) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();
                    gameOverRevealRequested = true;
                    hideNativeFailureLayersAndControls();
                    renderGameOverOverlay();
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                void startFreshSingleplayer(button);
            }, true);
        }
        return true;
    }

    function refreshOfficialResultButtons() {
        if (getCountryStreakStage(latestSnapshot) !== "result") return;
        const resultLayer = getNativeRoundResultLayer();
        if (!resultLayer) return;
        for (const button of resultLayer.querySelectorAll("button, a")) {
            const label = `${button.textContent || ""} ${button.getAttribute("title") || ""} ${button.getAttribute("aria-label") || ""}`.toLowerCase();
            if (!/(next\s+round|play\s+again|continue|view\s+game\s+over)/i.test(label)) continue;
            patchFifthRoundNextButton(button);
        }
    }

    function renderFifthRoundNextControl() {
        // Only patch the official result-layer button. Never create a second
        // control and never show any Next Round control while guessing.
        if (getCountryStreakStage(latestSnapshot) !== "result") {
            removeCountryStreakFifthNextControl();
            return;
        }
        if (!isCountryStreakFifthRoundSuccess() && !state.lastLoss) {
            removeCountryStreakFifthNextControl();
            return;
        }
        const nativeButton = findNativeFifthRoundNextButton();
        removeCountryStreakFifthNextControl();
        if (nativeButton) patchFifthRoundNextButton(nativeButton);
    }

    function renderLossReviewControl() {
        // The loss action must be the official result-layer button itself.
        if (!state.lastLoss || !settings.enabled || !isInSingleplayer() || gameOverRevealRequested) return;
        const nativeButton = findNativeFifthRoundNextButton();
        if (nativeButton) patchFifthRoundNextButton(nativeButton);
    }

    function removeCountryStreakStageOverlay() {
        setCountryStreakResultLock(false);
        removeCountryStreakMatchEndHUD();
        removeCountryStreakFifthNextControl();
        restoreNativeResultStyles();
        countryStreakStageOverlay?.remove();
        countryStreakStageOverlay = null;
    }

    function renderCountryStreakStageOverlay() {
        const stage = getCountryStreakStage();
        if (!stage) {
            removeCountryStreakStageOverlay();
            return;
        }
        const result = getLatestRoundResult();
        const resultKey = getStableResultKey(result);
        const summary = resultKey && lastRoundSummary?.key === resultKey ? lastRoundSummary : null;
        const currentStreak = Math.max(0, Number(summary?.streak ?? state.currentStreak) || 0);
        const personalBest = Math.max(0, Number(summary?.best ?? getDisplayedBestStreak()) || 0);
        if (stage === "result") {
            setCountryStreakResultLock(true);
            hideNativeResultScore();
        } else {
            setCountryStreakResultLock(false);
            restoreNativeResultStyles();
        }
        const hudKey = `${stage}:${resultKey || currentRoundId || latestRoundNumber}:${currentStreak}:${personalBest}`;
        if (!countryStreakStageOverlay || !document.body.contains(countryStreakStageOverlay)) {
            countryStreakStageOverlay = document.createElement("div");
            countryStreakStageOverlay.id = "gd-country-streak-stage-hud";
            document.body.appendChild(countryStreakStageOverlay);
        }
        if (countryStreakStageOverlay.dataset.gdStageKey === hudKey) return;
        countryStreakStageOverlay.dataset.gdStageKey = hudKey;
        countryStreakStageOverlay.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483000;display:flex;align-items:center;gap:16px;box-sizing:border-box;max-width:calc(100vw - 32px);padding:9px 17px;border:1px solid rgba(56,239,125,.42);border-radius:18px;background:rgba(10,14,23,.90);backdrop-filter:blur(10px);box-shadow:0 4px 20px rgba(0,0,0,.5);font-family:ui-sans-serif,system-ui,sans-serif;pointer-events:none;user-select:none;";
        countryStreakStageOverlay.innerHTML = `<div style="text-align:center;"><div style="font-size:9px;font-weight:800;letter-spacing:.15em;color:#38ef7d;line-height:1;">STREAK</div><div style="font-size:24px;font-weight:900;color:#fff;line-height:1.1;margin-top:2px;">${currentStreak}</div></div><div style="text-align:center;border-left:1px solid rgba(255,255,255,.15);padding-left:14px;"><div style="font-size:9px;font-weight:800;letter-spacing:.15em;color:rgba(255,255,255,.55);line-height:1;">PERSONAL BEST</div><div style="font-size:18px;font-weight:800;color:rgba(255,255,255,.82);line-height:1.1;margin-top:2px;">${personalBest}</div></div>`;
    }

    function renderGameOverOverlay() {
        if (!settings.enabled || !isInSingleplayer() || !state.lastLoss) {
            removeGameOverOverlay();
            return;
        }
        const loss = state.lastLoss;
        const overlayKey = `${matchId || "current"}:${loss.round}:${loss.finalStreak}:${loss.actualCountry}:${loss.guessedCountry}`;
        if (gameOverOverlay && gameOverOverlayKey === overlayKey && document.body.contains(gameOverOverlay)) return;
        removeGameOverOverlay();
        gameOverRevealRequested = true;
        gameOverOverlayKey = overlayKey;
        gameOverOverlay = document.createElement("div");
        gameOverOverlay.id = "gd-game-over-overlay";
        gameOverOverlay.className = "app-layer-match-end gd-native-style-game-over";
        gameOverOverlay.style.cssText = "position:fixed;inset:0;z-index:2147483001;display:flex;flex-direction:column;background:#070b0e;color:#fff;font-family:ui-sans-serif,system-ui,sans-serif;";
        gameOverOverlay.innerHTML = `
            <div style="position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;background:#070b0e;">
                <div style="text-align:center;text-shadow:0 4px 30px rgba(0,0,0,0.75);">
                    <div style="font-size:13px;font-weight:900;letter-spacing:0.24em;color:#fca5a5;text-transform:uppercase;">Country Streak</div>
                    <div style="margin-top:8px;font-size:clamp(42px,7vw,82px);font-weight:1000;line-height:0.95;letter-spacing:0.04em;color:#fff;">GAME OVER</div>
                </div>
            </div>
            <div style="flex:0 0 auto;max-height:52vh;overflow-y:auto;background:#070b0e;border-top:1px solid rgba(255,255,255,0.10);padding:28px 24px 30px;box-shadow:0 -18px 50px rgba(0,0,0,0.52);">
                <div style="width:min(920px,100%);margin:0 auto;text-align:center;">
                    <div style="font-size:12px;font-weight:900;letter-spacing:0.20em;color:#fca5a5;text-transform:uppercase;">Streak ended</div>
                    <div style="margin-top:10px;font-size:clamp(42px,7vw,68px);font-weight:1000;line-height:1;color:#fff;">${loss.finalStreak} <span style="font-size:18px;color:#7dc3ff;letter-spacing:0.08em;">ROUNDS</span></div>
                    <div style="width:min(560px,100%);margin:18px auto 0;padding:14px 18px;border:1px solid rgba(255,255,255,0.10);border-radius:18px;background:rgba(255,255,255,0.045);text-align:left;font-size:13px;line-height:1.7;">
                        <div>Your guess: <b style="color:#fca5a5;">${escapeHTML(loss.guessedCountry)}</b></div>
                        <div>Correct country: <b style="color:#77f0be;">${escapeHTML(loss.actualCountry)}</b></div>
                        <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08);color:#a9bfd4;">Best streak: <b style="color:#fbbf24;">${getDisplayedBestStreak()}</b> &nbsp; Total correct: <b style="color:#77f0be;">${state.totalCorrect}</b> &nbsp; Total guesses: <b style="color:#dbe7ff;">${state.totalGuessed}</b></div>
                    </div>
                    <div style="display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;margin-top:22px;">
                        <button id="gd-game-over-next" type="button" style="min-width:240px;height:56px;border:0;border-radius:999px;padding:0 32px;background:linear-gradient(135deg,#2ad18f 0%,#12a86f 100%);color:#fff;font-size:15px;font-weight:1000;letter-spacing:0.12em;cursor:pointer;box-shadow:0 0 20px rgba(42,209,143,0.28);">NEXT ROUND</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(gameOverOverlay);
        gameOverOverlay.querySelector("#gd-game-over-next")?.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            saveState();
            const pending = evaluationInFlight?.promise;
            if (pending) {
                void Promise.resolve(pending).catch(() => {}).then(() => startFreshSingleplayer(event.currentTarget));
            } else {
                void startFreshSingleplayer(event.currentTarget);
            }
        }, true);
    }

    function repairGameOverOverlayNow() {
        if (!state.lastLoss || !settings.enabled || !isInSingleplayer()) return;
        setFailureLockClass(true);
        hideNativeNextRoundDuringFailureTransition();
        if (gameOverRevealRequested) {
            renderGameOverOverlay();
            patchGameOverNextRoundEvent();
        } else {
            removeGameOverOverlay();
            renderLossReviewControl();
        }
    }

    function patchGameOverNextRoundEvent() {
        if (!state.lastLoss || !gameOverOverlay) return;
        for (const button of document.querySelectorAll("button, a")) {
            if (gameOverOverlay.contains(button)) continue;
            const label = `${button.textContent || ""} ${button.getAttribute("title") || ""} ${button.getAttribute("aria-label") || ""}`.toLowerCase();
            if (!label.includes("next round") || button.dataset.gdGameOverBlocked) continue;
            button.dataset.gdGameOverBlocked = "true";
            button.addEventListener("click", (event) => {
                if (button.dataset.gdCountryStreakAllowNext === "true") {
                    delete button.dataset.gdCountryStreakAllowNext;
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                renderGameOverOverlay();
            }, true);
        }
    }

    function continueNativeNextRound(button) {
        button.dataset.gdAllowNativeNextRound = "true";
        if (typeof button.click === "function") button.click();
        else button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: targetWin }));
    }

    function patchNativeNextRoundEvent(endLayer) {
        for (const button of endLayer.querySelectorAll("button, a")) {
            const label = `${button.textContent || ""} ${button.getAttribute("title") || ""} ${button.getAttribute("aria-label") || ""}`.toLowerCase();
            const isNativeNextRound = label.includes("play again") || label.includes("next round") || label.includes("continue");
            if (!isNativeNextRound || button.dataset.gdNativeNextRound) continue;
            button.dataset.gdNativeNextRound = "true";
            button.addEventListener("click", (event) => {
                if (button.dataset.gdAllowNativeNextRound === "true") {
                    delete button.dataset.gdAllowNativeNextRound;
                    saveState();
                    return;
                }
                const pending = evaluationInFlight;
                if (!pending && !hasPendingSubmissionForMatch(matchId)) {
                    saveState();
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                const evaluationDone = pending?.promise || Promise.resolve();
                void evaluationDone.then(async () => {
                    await waitForPendingSubmissions(matchId);
                    if (state.lastLoss) {
                        renderGameOverOverlay();
                        patchGameOverNextRoundEvent();
                    } else {
                        continueNativeNextRound(button);
                    }
                });
            }, true);
        }
    }

    function patchPendingEvaluationNextRoundEvent() {
        if (!evaluationInFlight) return;
        for (const button of document.querySelectorAll("button, a")) {
            const label = `${button.textContent || ""} ${button.getAttribute("title") || ""} ${button.getAttribute("aria-label") || ""}`.toLowerCase();
            if (!label.includes("next round") || button.dataset.gdPendingEvaluationGuard) continue;
            button.dataset.gdPendingEvaluationGuard = "true";
            button.addEventListener("click", (event) => {
                const pending = evaluationInFlight;
                if (!pending) return;
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                void pending.promise.then(async () => {
                    await waitForPendingSubmissions(matchId);
                    if (state.lastLoss) {
                        renderGameOverOverlay();
                        patchGameOverNextRoundEvent();
                    } else {
                        continueNativeNextRound(button);
                    }
                });
            }, true);
        }
    }

    function isCountryStreakFailureActive() {
        // Do not treat an in-flight country lookup as a failure. Correct guesses
        // must keep the official NEXT ROUND control visible; only a confirmed
        // lastLoss activates the custom Game Over flow.
        return settings.enabled && isInSingleplayer() && Boolean(state.lastLoss);
    }

    function setFailureLockClass(active) {
        const locked = Boolean(active);
        document.documentElement?.classList.toggle("gd-country-streak-failure-lock", locked);
        document.body?.classList.toggle("gd-country-streak-failure-lock", locked);
    }

    function setMatchEndLockClass(active) {
        const locked = Boolean(active);
        document.documentElement?.classList.toggle("gd-country-streak-match-end-lock", locked);
        document.body?.classList.toggle("gd-country-streak-match-end-lock", locked);
    }

    function hideNativeFailureLayersAndControls() {
        const layers = [getNativeMatchEndLayer(), getNativeRoundResultLayer(), getNativeSingleplayerRoundPointsCard()].filter(Boolean);
        for (const layer of layers) {
            if (!failureTransitionHiddenElements.has(layer)) failureTransitionHiddenElements.set(layer, layer.style.cssText || "");
            layer.style.setProperty("display", "none", "important");
            layer.style.setProperty("pointer-events", "none", "important");
        }
        for (const element of document.querySelectorAll("button, a")) {
            if (gameOverOverlay?.contains(element)) continue;
            const insideNativeLayer = layers.some((layer) => layer.contains(element));
            const label = `${element.textContent || ""} ${element.getAttribute("title") || ""} ${element.getAttribute("aria-label") || ""}`.toLowerCase();
            const isRoundControl = /(next\s+round|play\s+again|back\s+to\s+(lobby|party)|continue)/i.test(label);
            if (!insideNativeLayer && !isRoundControl) continue;
            if (!failureTransitionHiddenElements.has(element)) failureTransitionHiddenElements.set(element, element.style.cssText || "");
            element.style.setProperty("display", "none", "important");
            element.style.setProperty("pointer-events", "none", "important");
            element.setAttribute("aria-hidden", "true");
        }
    }

    function hideNativeNextRoundDuringFailureTransition() {
        // Keep the official result layer and its single button visible. The
        // button is renamed to VIEW GAME OVER and owns the loss click action.
        if (!settings.enabled || !isInSingleplayer() || !state.lastLoss || !gameOverRevealRequested) return;
        hideNativeFailureLayersAndControls();
        for (const element of document.querySelectorAll("button, a")) {
            if (gameOverOverlay?.contains(element)) continue;
            const label = `${element.textContent || ""} ${element.getAttribute("title") || ""} ${element.getAttribute("aria-label") || ""}`.toLowerCase();
            if (!/(next\s+round|play\s+again|back\s+to\s+(lobby|party)|continue)/i.test(label)) continue;
            if (!failureTransitionHiddenElements.has(element)) failureTransitionHiddenElements.set(element, element.style.cssText || "");
            element.style.setProperty("display", "none", "important");
            element.setAttribute("aria-hidden", "true");
        }
    }

    function restoreFailureTransitionHiddenElements() {
        for (const [element, originalStyle] of failureTransitionHiddenElements.entries()) {
            if (element && element.isConnected) element.style.cssText = originalStyle || "";
            if (element && element.getAttribute("aria-hidden") === "true") element.removeAttribute("aria-hidden");
            failureTransitionHiddenElements.delete(element);
        }
    }

    function getCountryStreakNextRoundControl(element) {
        if (!element) return null;
        const control = element instanceof Element ? element.closest("button, a") : element.parentElement?.closest("button, a");
        if (!control) return null;
        const label = `${control.textContent || ""} ${control.getAttribute("title") || ""} ${control.getAttribute("aria-label") || ""}`.toLowerCase();
        return /(next\s+round|play\s+again|back\s+to\s+(lobby|party)|continue)/i.test(label) ? control : null;
    }

    function installFailureNextRoundBlocker() {
        if (failureClickBlockerInstalled) return;
        failureClickBlockerInstalled = true;
        document.addEventListener("click", (event) => {
            if (!isCountryStreakFailureActive()) return;
            const control = getCountryStreakNextRoundControl(event.target);
            if (!control || gameOverOverlay?.contains(control)) return;
            if (control.dataset.gdCountryStreakAllowNext === "true" || control.dataset.gdAllowNativeNextRound === "true") return;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            hideNativeNextRoundDuringFailureTransition();
            requestTick();
        }, true);
    }

    function installFailureTransitionObserver() {
        if (failureTransitionObserver || !document.documentElement) return;
        failureTransitionObserver = new MutationObserver(() => {
            const failureActive = isCountryStreakFailureActive();
            setFailureLockClass(failureActive);
            if (failureActive) {
                hideNativeNextRoundDuringFailureTransition();
                if (state.lastLoss) repairGameOverOverlayNow();
            } else restoreFailureTransitionHiddenElements();
        });
        failureTransitionObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    function patchEndScreen() {
        const failureActive = isCountryStreakFailureActive();
        setFailureLockClass(failureActive);
        if (!settings.enabled || !isInSingleplayer()) {
            setCountryStreakInitialFrameLock(false);
            setMatchEndLockClass(false);
            restoreFailureTransitionHiddenElements();
            removeGameOverOverlay();
            removeCountryStreakStageOverlay();
            removeCountryStreakMatchEndHUD();
            removeTimerElement();
            return;
        }
        if (failureActive) {
            setMatchEndLockClass(false);
            hideNativeNextRoundDuringFailureTransition();
            removeCountryStreakStageOverlay();
            removeCountryStreakMatchEndHUD();
            if (state.lastLoss) {
                if (gameOverRevealRequested) {
                    renderGameOverOverlay();
                    patchGameOverNextRoundEvent();
                } else {
                    removeGameOverOverlay();
                    renderLossReviewControl();
                }
            } else {
                removeGameOverOverlay();
            }
            return;
        }
        restoreFailureTransitionHiddenElements();
        const matchEndLayer = getNativeMatchEndLayer();
        if (state.lastLoss) {
            removeCountryStreakStageOverlay();
            removeCountryStreakMatchEndHUD();
            renderGameOverOverlay();
            patchGameOverNextRoundEvent();
            return;
        }
        if (isCountryStreakFifthRoundSuccess()) {
            setMatchEndLockClass(Boolean(matchEndLayer));
            removeCountryStreakMatchEndHUD();
            if (matchEndLayer) hideNativeEntireMatchEndLayer(matchEndLayer);
            renderCountryStreakStageOverlay();
            renderFifthRoundNextControl();
            return;
        }
        if (matchEndLayer || (matchEnded && !state.lastLoss)) {
            setMatchEndLockClass(Boolean(matchEndLayer));
            removeGameOverOverlay();
            removeCountryStreakStageOverlay();
            if (matchEndLayer) hideNativeEntireMatchEndLayer(matchEndLayer);
            return;
        }
        setMatchEndLockClass(false);
        removeCountryStreakMatchEndHUD();
        const stage = getCountryStreakStage();
        if (stage) {
            removeGameOverOverlay();
            renderCountryStreakStageOverlay();
            return;
        }
        removeCountryStreakStageOverlay();
        removeGameOverOverlay();
    }

    function captureOutgoingCommand(raw) {
        if (typeof raw !== "string") return;
        try {
            const command = JSON.parse(raw);
            const payload = command?.payload || {};
            if (command?.type === "guess.place" && Number.isFinite(Number(payload.lat)) && Number.isFinite(Number(payload.lng))) {
                targetWin.__GD_LAST_GUESS__ = {
                    matchId: String(payload.matchId || ""),
                    roundId: String(payload.roundId || ""),
                    userId: String(payload.userId || ""),
                    lat: Number(payload.lat),
                    lng: Number(payload.lng)
                };
            }
            if (command?.type === "guess.finalize" && settings.enabled && isInSingleplayer()) {
                const finalizedMatchId = String(payload.matchId || matchId || "");
                const finalizedRoundId = String(payload.roundId || currentRoundId || "");
                if (Number.isFinite(Number(payload.lat)) && Number.isFinite(Number(payload.lng))) {
                    const finalizedGuess = {
                        matchId: finalizedMatchId,
                        roundId: finalizedRoundId,
                        userId: String(payload.userId || ""),
                        lat: Number(payload.lat),
                        lng: Number(payload.lng)
                    };
                    if (finalizedMatchId && finalizedRoundId) finalizedGuessByRound.set(`${finalizedMatchId}:${finalizedRoundId}`, finalizedGuess);
                    if (finalizedMatchId) latestFinalizedGuessByMatch.set(finalizedMatchId, finalizedGuess);
                }
                countryStreakFailureTransitionLock = true;
                countryStreakFailureMatchId = finalizedMatchId;
                setFailureLockClass(true);
                hideNativeNextRoundDuringFailureTransition();
            }
        } catch (_) {}
    }

    function getLatestGuess() {
        const guess = targetWin.__GD_LAST_GUESS__;
        if (!guess || (guess.matchId && matchId && guess.matchId !== matchId) || (guess.roundId && currentRoundId && guess.roundId !== currentRoundId)) return null;
        return guess;
    }

    function sendTimeoutGuess() {
        if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN || !matchId || !currentRoundId) return;
        const latestGuess = getLatestGuess();
        const sessionUserId = sessionCache?.userId || latestGuess?.userId || "";
        const lat = latestGuess?.lat ?? 0;
        const lng = latestGuess?.lng ?? 0;
        const basePayload = { userId: sessionUserId, matchId, roundId: currentRoundId, lat, lng };
        try {
            const commandBase = `${sessionUserId || "anon"}-${Date.now()}`;
            activeSocket.send(JSON.stringify({ commandId: `${commandBase}-place`, type: "guess.place", payload: basePayload, sentAt: Date.now() }));
            targetWin.setTimeout(() => {
                if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) return;
                activeSocket.send(JSON.stringify({ commandId: `${commandBase}-finalize`, type: "guess.finalize", payload: basePayload, sentAt: Date.now() }));
            }, 80);
        } catch (error) {
            console.error("[GeoDuels Country Streak] timeout submission failed", error);
        }
    }

    function removeTimerElement() {
        timerElement?.remove();
        timerHost?.remove();
        timerElement = null;
        timerHost = null;
    }

    function ensureStandaloneTimer() {
        if (timerHost?.isConnected && timerElement?.isConnected) return;
        timerHost?.remove();
        timerHost = document.createElement("div");
        timerHost.id = "gd-country-streak-timer-host";
        timerHost.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none!important;display:block!important;visibility:visible!important;opacity:1!important;";
        const shadowRoot = timerHost.attachShadow({ mode: "closed" });
        timerElement = document.createElement("div");
        timerElement.id = "gd-round-timer";
        shadowRoot.appendChild(timerElement);
        (document.documentElement || document.body).appendChild(timerHost);
    }

    let avatarStyleElement = null;

    function patchSelfGuessMarkerAvatar() {
        const avatarUrl = sessionCache?.avatarUrl;
        if (!avatarStyleElement) {
            avatarStyleElement = document.createElement("style");
            avatarStyleElement.id = "gd-country-streak-avatar-style";
            (document.head || document.documentElement).appendChild(avatarStyleElement);
        }
        if (!avatarUrl || !/^(?:https?:)?\/\//i.test(avatarUrl) || !isInSingleplayer()) {
            avatarStyleElement.textContent = "";
            return;
        }
        const safeAvatarUrl = avatarUrl.replace(/["\\)\r\n]/g, (character) => `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`);
        const preload = new Image();
        preload.referrerPolicy = "no-referrer";
        preload.src = avatarUrl;
        avatarStyleElement.textContent = `.minimap-interactive .guess-avatar-marker .guessAvatarPin.fallback{background-image:url("${safeAvatarUrl}") !important;background-size:cover !important;background-position:center !important;background-repeat:no-repeat !important;color:transparent !important;}`;
    }

    function renderRoundTimer() {
        const limitSeconds = getConfiguredSeconds();
        const live = latestSnapshot?.phase === "live"
            && latestSnapshot?.roundPhase === "round_live"
            && currentRoundStartedAtMs > 0;
        if (!live || limitSeconds <= 0 || !settings.enabled || !isInSingleplayer()) {
            removeTimerElement();
            return;
        }
        ensureStandaloneTimer();
        const remainingMs = Math.max(0, limitSeconds * 1000 - (Date.now() - currentRoundStartedAtMs));
        const remainingSeconds = Math.ceil(remainingMs / 1000);
        const urgent = remainingSeconds <= 10;
        timerElement.style.cssText = `position:fixed;left:12px;top:calc(env(safe-area-inset-top, 0px) + 78px);transform:none;min-width:124px;max-width:calc(100vw - 24px);box-sizing:border-box;padding:8px 13px;border:1px solid ${urgent ? "rgba(252,165,165,.78)" : "rgba(42,209,143,.62)"};border-radius:12px;background:${urgent ? "rgba(127,29,29,.94)" : "rgba(7,16,22,.94)"};box-shadow:0 6px 18px rgba(0,0,0,.30);color:#fff;text-align:center;font-family:ui-sans-serif,system-ui,sans-serif;font-size:12px;font-weight:1000;line-height:1.2;letter-spacing:.10em;pointer-events:none;user-select:none;contain:paint;`;
        timerElement.textContent = remainingMs > 0 ? `TIME ${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, "0")}` : "TIME UP";
        if (remainingMs <= 0 && !currentRoundExpired) {
            currentRoundExpired = true;
            sendTimeoutGuess();
        }
    }

    function startStandaloneTimerLoop() {
        if (timerInterval) return;
        const tick = () => renderRoundTimer();
        timerInterval = targetWin.setInterval(tick, 250);
        tick();
    }

    function updateRoundTimerFromSnapshot(snap) {
        const phase = snap?.roundPhase;
        const isLiveRound = snap?.phase === "live" && phase === "round_live";
        if (!isLiveRound) {
            if (phase !== "round_result") resetRoundTimer();
            return;
        }

        const round = snap?.currentRound || {};
        const nextRoundNumber = Number(round.roundNumber || round.number || latestRoundNumber || roundIndex + 1) || 1;
        const nextRoundId = String(
            round.roundId
            || round.id
            || snap?.roundId
            || snap?.currentRoundId
            || (matchId ? `${matchId}:r${nextRoundNumber}` : `round-${nextRoundNumber}`)
        );
        if (nextRoundId !== currentRoundId || nextRoundNumber !== currentRoundNumber) {
            currentRoundId = nextRoundId;
            currentRoundNumber = nextRoundNumber;
            roundIndex = Math.max(roundIndex, nextRoundNumber);
            const persistedStart = state.activeMatchId === matchId && state.activeRoundId === nextRoundId
                ? Number(state.activeRoundStartedAtMs) || 0
                : 0;
            const snapshotStart = toTimestampMs(
                round.startedAtMs
                || round.roundStartedAtMs
                || snap.roundStartedAtMs
                || snap.phaseStartedAt
            );
            const nowMs = Date.now();
            const saneSnapshotStart = snapshotStart > 0 && snapshotStart <= nowMs + 1000 ? snapshotStart : 0;
            const sanePersistedStart = persistedStart > 0 && persistedStart <= nowMs + 1000 ? persistedStart : 0;
            currentRoundStartedAtMs = sanePersistedStart || saneSnapshotStart || nowMs;
            state.activeRoundId = nextRoundId;
            state.activeRoundStartedAtMs = currentRoundStartedAtMs;
            saveState();
            currentRoundExpired = false;
            if (state.lastLoss && nextRoundNumber > Math.max(0, Number(state.lastLoss.round) || 0)) {
                state.lastLoss = null;
                countryStreakFailureTransitionLock = false;
                countryStreakFailureMatchId = "";
                gameOverRevealRequested = false;
                setFailureLockClass(false);
                restoreFailureTransitionHiddenElements();
                removeGameOverOverlay();
                saveState();
            }
            renderRoundTimer();
            const latestGuess = getLatestGuess();
            if (latestGuess && latestGuess.roundId !== currentRoundId) targetWin.__GD_LAST_GUESS__ = null;
        }
    }

    function extractJsonPayload(raw) {
        if (typeof raw !== "string") return null;
        try {
            const direct = JSON.parse(raw);
            if (direct && typeof direct === "object") return direct.payload && typeof direct.payload === "object" ? direct.payload : direct;
        } catch (_) {}
        const cleaned = raw.replace(/^\d+(\/?[^,]*,)?/, "");
        try {
            const parsed = JSON.parse(cleaned);
            return Array.isArray(parsed) && parsed.length >= 2 && typeof parsed[1] === "object" ? parsed[1] : parsed;
        } catch (_) {
            return null;
        }
    }

    function getAuthoritativeGuessCoordinates(result, roundId) {
        // Official RoundResult players contain the actual submitted guess for
        // this exact round. In singleplayer, the result has one self player;
        // prefer the matching GeoDuels user when it is available.
        const players = result?.players && typeof result.players === "object" ? result.players : {};
        const wantedId = String(sessionCache?.userId || "");
        const officialPlayer = wantedId
            ? (players[wantedId] || Object.values(players).find((player) => player && String(player.userId || player.user_id || "") === wantedId))
            : Object.values(players).find((player) => player && typeof player === "object");
        if (officialPlayer && Number.isFinite(Number(officialPlayer.lat)) && Number.isFinite(Number(officialPlayer.lng))) {
            return { lat: Number(officialPlayer.lat), lng: Number(officialPlayer.lng) };
        }
        const normalizedMatchId = String(matchId || latestSnapshot?.matchId || "");
        const normalizedRoundId = String(roundId || "");
        const storedGuess = normalizedRoundId
            ? finalizedGuessByRound.get(`${normalizedMatchId}:${normalizedRoundId}`)
            : latestFinalizedGuessByMatch.get(normalizedMatchId);
        if (storedGuess && Number.isFinite(Number(storedGuess.lat)) && Number.isFinite(Number(storedGuess.lng))) {
            return { lat: Number(storedGuess.lat), lng: Number(storedGuess.lng) };
        }
        const latestGuess = getLatestGuess();
        if (latestGuess && Number.isFinite(Number(latestGuess.lat)) && Number.isFinite(Number(latestGuess.lng))) {
            const guessRoundId = String(latestGuess.roundId || "");
            const sameRound = guessRoundId && normalizedRoundId
                ? guessRoundId === normalizedRoundId
                : (!guessRoundId && !normalizedRoundId) || guessRoundId === currentRoundId;
            if (sameRound) return { lat: Number(latestGuess.lat), lng: Number(latestGuess.lng) };
        }
        const candidateLocations = [
            officialPlayer?.guess,
            officialPlayer?.currentGuess,
            officialPlayer?.guessLocation,
            officialPlayer?.guess_location,
            result?.self?.currentGuess,
            result?.self?.guess,
            result?.playerGuess,
            result?.player_guess
        ];
        for (const candidate of candidateLocations) {
            if (Number.isFinite(Number(candidate?.lat)) && Number.isFinite(Number(candidate?.lng))) {
                return { lat: Number(candidate.lat), lng: Number(candidate.lng) };
            }
        }
        return null;
    }

    function applyCountryStreakResultFrameLock(snap) {
        if (!settings.enabled || !isInSingleplayer() || !snap) return;
        const stage = getCountryStreakStage(snap);
        if (stage === "result" || stage === "preparation") {
            setCountryStreakInitialFrameLock(false);
            setCountryStreakResultLock(true);
            hideNativeResultScore();
        } else if (snap.phase === "live" && snap.roundPhase === "round_live") {
            setCountryStreakInitialFrameLock(false);
            if (!evaluationInFlight && !state.lastLoss) setCountryStreakResultLock(false);
        } else if (!evaluationInFlight && !state.lastLoss) {
            setCountryStreakResultLock(false);
        }
    }

    function processPacket(json) {
        if (!json || typeof json !== "object") return;
        const incomingSnapshot = json.payload && typeof json.payload === "object" ? json.payload : json;
        const previousSnapshot = latestSnapshot && typeof latestSnapshot === "object" ? latestSnapshot : {};
        const snap = {
            ...previousSnapshot,
            ...incomingSnapshot,
            currentRound: incomingSnapshot.currentRound && typeof incomingSnapshot.currentRound === "object"
                ? { ...(previousSnapshot.currentRound || {}), ...incomingSnapshot.currentRound }
                : previousSnapshot.currentRound
        };
        if (snap.matchId || snap.match_id) resetMatchTracking(snap.matchId || snap.match_id);
        if (snap.config && typeof snap.config === "object") latestMatchConfig = { ...snap.config };
        latestSnapshot = snap;
        if (!reactHydrationSettled && snap.phase === "live" && snap.roundPhase === "round_live") {
            pendingInitialLiveSnapshot = snap;
        }
        if (snap.mode) {
            const mode = String(snap.mode).toLowerCase();
            isSingleplayer = mode === "singleplayer" || mode === "solo" || mode === "practice";
            if (!isSingleplayer) {
                clearCountryStreakIntent();
                clearCompetitionLaunchIntent();
                isSingleplayer = false;
                setCountryStreakInitialFrameLock(false);
                resetRoundTimer();
                removeGameOverOverlay();
                requestTick();
                return;
            }
        }
        // Apply the result HUD lock in the same websocket task, before the
        // following React commit can paint the native Round/Points card.
        applyCountryStreakResultFrameLock(snap);
        updateRoundTimerFromSnapshot(snap);
        renderRoundTimer();
        if (Array.isArray(snap.roundResults)) {
            latestRoundCount = Math.max(latestRoundCount, snap.roundResults.length);
            const lastResult = snap.roundResults[snap.roundResults.length - 1];
            if (lastResult?.roundNumber) latestRoundNumber = Math.max(latestRoundNumber, Number(lastResult.roundNumber) || 0);
        }
        if (snap.lastRoundResult?.roundNumber) {
            latestRoundNumber = Math.max(latestRoundNumber, Number(snap.lastRoundResult.roundNumber) || 0);
            latestRoundCount = Math.max(latestRoundCount, latestRoundNumber);
        }
        if (snap.currentRound?.roundNumber) latestRoundNumber = Math.max(latestRoundNumber, Number(snap.currentRound.roundNumber) || 0);
        if (isFinishedMatchSnapshot(snap)) {
            matchEnded = true;
            if (isCompetitionMode() && state.activeEvents.length) submitCompetitionWhenReady(matchId);
            requestTick();
        }

        const result = getLatestRoundResult(snap);
        if (!result?.actualLocation) {
            requestTick();
            return;
        }
        const round = getResultRoundNumber(result, snap);
        // Never use currentRoundId as a result fallback: during the official
        // inter-round screen currentRound may already point at the next round.
        const roundId = String(result.roundId || result.id || snap.lastRoundResult?.roundId || "");
        const resultKey = getStableResultKey(result, snap);
        const guess = getAuthoritativeGuessCoordinates(result, roundId);
        const actualLat = Number(result.actualLocation.lat);
        const actualLng = Number(result.actualLocation.lng);
        const evaluationKey = `${resultKey || `${matchId || "sp"}:${roundId || "round"}:${round}`}:${Number.isFinite(actualLat) ? actualLat.toFixed(3) : ""}:${Number.isFinite(actualLng) ? actualLng.toFixed(3) : ""}`;
        const eventAlreadyRecorded = state.activeEvents.some((event) => event.roundId === roundId && event.roundNumber === Number(round));
        const evaluationAlreadyRunning = evaluationInFlight?.key === evaluationKey;
        if (!processedResultKeys.has(resultKey) && !seenRoundKeys.has(evaluationKey) && !eventAlreadyRecorded && !evaluationAlreadyRunning) {
            countryStreakFailureTransitionLock = true;
            countryStreakFailureMatchId = String(matchId || "");
            setFailureLockClass(true);
            hideNativeNextRoundDuringFailureTransition();
            const evaluationPromise = evaluate(result.actualLocation, guess, round, roundId, currentRoundStartedAtMs || Date.now(), Date.now());
            evaluationInFlight = { key: evaluationKey, promise: evaluationPromise };
            void evaluationPromise.then(() => {
                processedResultKeys.add(resultKey);
                rememberRoundSummary(result, resultKey, guess);
                if (evaluationInFlight?.key === evaluationKey) evaluationInFlight = null;
                // The native result layer may have been rendered and hidden
                // during the async lookup. Re-open it explicitly on success,
                // then repaint after React's next commit so the normal NEXT
                // ROUND remains available.
                if (!state.lastLoss) {
                    countryStreakFailureTransitionLock = false;
                    countryStreakFailureMatchId = "";
                    setFailureLockClass(false);
                    restoreFailureTransitionHiddenElements();
                }
                requestTick();
                targetWin.setTimeout(() => {
                    if (!state.lastLoss) {
                        setFailureLockClass(false);
                        restoreFailureTransitionHiddenElements();
                        requestTick();
                    }
                }, 120);
            }, () => {
                if (evaluationInFlight?.key === evaluationKey) evaluationInFlight = null;
                if (!state.lastLoss) {
                    countryStreakFailureTransitionLock = false;
                    countryStreakFailureMatchId = "";
                    setFailureLockClass(false);
                    restoreFailureTransitionHiddenElements();
                }
                requestTick();
            });
        } else if (resultKey && lastRoundSummary?.key !== resultKey) {
            // A reload may restore the event from state before the first full
            // result snapshot arrives; still make the in-memory summary visible.
            processedResultKeys.add(resultKey);
            rememberRoundSummary(result, resultKey, guess);
        }
        requestTick();
    }

    const OriginalWebSocket = targetWin.WebSocket;
    if (OriginalWebSocket) {
        const PatchedWebSocket = function (...args) {
            const socket = new OriginalWebSocket(...args);
            activeSocket = socket;
            const originalSend = socket.send.bind(socket);
            socket.send = (raw) => {
                captureOutgoingCommand(raw);
                return originalSend(raw);
            };
            socket.addEventListener("message", (event) => {
                const data = extractJsonPayload(event.data);
                if (data) processPacket(data);
            });
            socket.addEventListener("close", () => {
                if (activeSocket === socket) {
                    activeSocket = null;
                    latestSnapshot = null;
                    if (!state.lastLoss) {
                        countryStreakFailureTransitionLock = false;
                        countryStreakFailureMatchId = "";
                        setFailureLockClass(false);
                        restoreFailureTransitionHiddenElements();
                    }
                    requestTick();
                }
            });
            socket.addEventListener("error", () => requestTick());
            return socket;
        };
        PatchedWebSocket.prototype = OriginalWebSocket.prototype;
        for (const property of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
            if (property in OriginalWebSocket) PatchedWebSocket[property] = OriginalWebSocket[property];
        }
        targetWin.WebSocket = PatchedWebSocket;
    }

    function patchHistory() {
        let previousBase = `${location.pathname}${location.search}`;
        const dispatchNavigation = () => {
            const currentBase = `${location.pathname}${location.search}`;
            const pathChanged = currentBase !== previousBase;
            previousBase = currentBase;
            window.dispatchEvent(new CustomEvent("gd:navigation", { detail: { pathChanged } }));
        };
        for (const method of ["pushState", "replaceState"]) {
            const original = targetWin.history[method];
            if (typeof original !== "function") continue;
            targetWin.history[method] = function (...args) {
                const result = original.apply(this, args);
                dispatchNavigation();
                return result;
            };
        }
        window.addEventListener("popstate", dispatchNavigation);
        window.addEventListener("gd:navigation", (event) => {
            const pathChanged = event?.detail?.pathChanged !== false;
            const gameRoute = /\/(singleplayer|practice)\b/i.test(location.pathname) || /\/match\//i.test(location.pathname);
            isSingleplayer = gameRoute;
            if (pathChanged && !gameRoute) {
                clearCountryStreakIntent();
                clearCompetitionLaunchIntent();
                isSingleplayer = false;
            }
            latestSnapshot = null;
            avatarLookupRequested = false;
            resetRoundTimer();
            requestTick();
        });
    }

    let hudElement = null;
    let lastHUDKey = "";

    function isCountryStreakLiveRound() {
        return settings.enabled
            && isInSingleplayer()
            && latestSnapshot?.phase === "live"
            && latestSnapshot?.roundPhase === "round_live"
            && currentRoundStartedAtMs > 0;
    }

    function removeHUD() {
        hudElement?.remove();
        hudElement = null;
        lastHUDKey = "";
    }

    function ensureHUD() {
        if (hudElement && document.body?.contains(hudElement)) return;
        if (!document.body) return;
        hudElement = document.createElement("div");
        hudElement.id = "gd-streak-hud";
        document.body.appendChild(hudElement);
        renderHUD();
    }

    function renderHUD() {
        if (!isCountryStreakLiveRound()) {
            removeHUD();
            return;
        }
        ensureHUD();
        if (!hudElement) return;
        const visible = true;
        hudElement.style.display = "flex";
        const hudKey = `${state.currentStreak}_${getDisplayedBestStreak()}_${state.totalGuessed}_${settings.competitionMode}`;
        if (lastHUDKey === hudKey) return;
        lastHUDKey = hudKey;
        hudElement.style.cssText = `position:fixed;top:16px;right:16px;z-index:2147483000;display:flex;align-items:center;gap:16px;background:rgba(10,14,23,0.85);border:1px solid rgba(56,239,125,0.35);border-radius:18px;padding:8px 18px;backdrop-filter:blur(10px);box-shadow:0 4px 20px rgba(0,0,0,0.5);font-family:ui-sans-serif,system-ui,sans-serif;pointer-events:none;user-select:none;`;
        hudElement.innerHTML = `
            <div style="text-align:center;"><div style="font-size:9px;font-weight:800;letter-spacing:0.15em;color:#38ef7d;line-height:1;">STREAK</div><div style="font-size:24px;font-weight:900;color:#ffffff;line-height:1.1;margin-top:2px;">${state.currentStreak}</div></div>
            <div style="text-align:center;border-left:1px solid rgba(255,255,255,0.15);padding-left:14px;"><div style="font-size:9px;font-weight:800;letter-spacing:0.15em;color:rgba(255,255,255,0.4);line-height:1;">PERSONAL BEST</div><div style="font-size:18px;font-weight:800;color:rgba(255,255,255,0.7);line-height:1.1;margin-top:2px;">${getDisplayedBestStreak()}</div></div>
            ${settings.competitionMode ? '<div style="font-size:9px;font-weight:900;letter-spacing:0.12em;color:#fbbf24;">COMPETITION</div>' : ""}`;
    }

    let styleElement = null;

    function applyHUDVisibility() {
        if (!styleElement) {
            styleElement = document.createElement("style");
            (document.head || document.documentElement).appendChild(styleElement);
        }
        styleElement.textContent = isCountryStreakLiveRound()
            ? `.absolute.right-3.top-3.z-30.flex.items-center.gap-5.rounded-\\[18px\\], .absolute.right-4.top-4.z-30.flex.items-center.gap-5.rounded-\\[18px\\] { opacity:0 !important; pointer-events:none !important; }`
            : "";
    }

    function findPlayModal() {
        const modals = document.querySelectorAll('div[role="dialog"], .rounded-3xl, .fixed.inset-0');
        return Array.from(modals).find((modal) => {
            const ariaLabel = (modal.getAttribute("aria-label") || "").trim().toLowerCase();
            if (ariaLabel === "start singleplayer") return true;
            const text = (modal.textContent || "").toLowerCase();
            return text.includes("start singleplayer") && !text.includes("find a duel");
        }) || null;
    }

    function findLaunchOptionButton(modal, label) {
        const normalizedLabel = String(label || "").trim().toLowerCase();
        return Array.from(modal.querySelectorAll("button")).find((button) => {
            const ariaLabel = (button.getAttribute("aria-label") || "").trim().toLowerCase();
            const text = (button.textContent || "").trim().toLowerCase();
            return ariaLabel === normalizedLabel || text === normalizedLabel;
        }) || null;
    }

    function isLaunchOptionSelected(button) {
        return button?.getAttribute("aria-pressed") === "true";
    }

    function enforceCompetitionLaunchRules(modal) {
        if (!modal || !shouldForceCompetitionLaunch()) return;
        const moving = findLaunchOptionButton(modal, "moving");
        if (moving && !isLaunchOptionSelected(moving)) {
            moving.click();
            return;
        }
        const hidden = findLaunchOptionButton(modal, "hidden");
        if (hidden && !isLaunchOptionSelected(hidden)) hidden.click();
    }

    function setCompetitionDisabled(button, disabled) {
        if (!button) return;
        if (disabled) {
            if (!button.dataset.gdCompetitionDisabled) {
                button.dataset.gdCompetitionDisabled = "true";
                button.dataset.gdNativeDisabled = button.disabled ? "true" : "false";
            }
            button.disabled = true;
            button.setAttribute("aria-disabled", "true");
            button.style.opacity = "0.38";
            button.style.filter = "grayscale(0.45)";
            button.style.cursor = "not-allowed";
            button.title = "Competition mode requires Moving and Hide street names.";
            return;
        }
        if (button.dataset.gdCompetitionDisabled !== "true") return;
        button.disabled = button.dataset.gdNativeDisabled === "true";
        if (button.disabled) button.setAttribute("aria-disabled", "true");
        else button.removeAttribute("aria-disabled");
        button.style.opacity = "";
        button.style.filter = "";
        button.style.cursor = "";
        if (button.title === "Competition mode requires Moving and Hide street names.") button.removeAttribute("title");
        delete button.dataset.gdCompetitionDisabled;
        delete button.dataset.gdNativeDisabled;
    }

    function applyCompetitionOptionStyles(modal) {
        if (!modal) return;
        const competitionActive = shouldForceCompetitionLaunch();
        const moving = findLaunchOptionButton(modal, "moving");
        const noMove = findLaunchOptionButton(modal, "no move");
        const nmpz = findLaunchOptionButton(modal, "nmpz");
        const shown = findLaunchOptionButton(modal, "shown");
        const hidden = findLaunchOptionButton(modal, "hidden");
        setCompetitionDisabled(noMove, competitionActive);
        setCompetitionDisabled(nmpz, competitionActive);
        setCompetitionDisabled(shown, competitionActive);
        if (moving && !competitionActive) setCompetitionDisabled(moving, false);
        if (hidden && !competitionActive) setCompetitionDisabled(hidden, false);
        if (competitionActive && hidden) {
            hidden.style.opacity = "1";
            hidden.style.filter = "none";
            hidden.style.cursor = "pointer";
            hidden.removeAttribute("aria-disabled");
        }
    }

    function installCompetitionStartGuard(modal) {
        const startButton = Array.from(modal.querySelectorAll("button")).find((button) => (button.textContent || "").trim().toLowerCase() === "start");
        if (!startButton || startButton.dataset.gdCompetitionStartGuard) return;
        startButton.dataset.gdCompetitionStartGuard = "true";
        startButton.addEventListener("click", async (event) => {
            if (!shouldForceCompetitionLaunch()) return;
            const moving = findLaunchOptionButton(modal, "moving");
            const hidden = findLaunchOptionButton(modal, "hidden");
            if (isLaunchOptionSelected(moving) && isLaunchOptionSelected(hidden)) {
                if (startButton.dataset.gdAllowCompetitionStart === "true") {
                    delete startButton.dataset.gdAllowCompetitionStart;
                    setCompetitionLaunchIntent();
                    return;
                }
                if (!leaderboardAccount?.accountId) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();
                    const accepted = await ensureUnifiedCountryStreakSetup();
                    if (!accepted) return;
                    startButton.dataset.gdAllowCompetitionStart = "true";
                    startButton.click();
                } else {
                    setCompetitionLaunchIntent();
                }
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            enforceCompetitionLaunchRules(modal);
            showToastNotice(hidden
                ? "Competition mode requires Moving and Hide street names. The selections have been restored; press Start again."
                : "Competition mode requires Moving and Hide street names. Please install or enable the GeoDuels extension first.", {
                title: "Competition rules",
                tone: "warning",
                duration: 6200
            });
        }, true);
    }

    function rememberCountryStreakRules(modal) {
        if (!hasCountryStreakIntent() || !modal) return;
        const selectedMode = Array.from(modal.querySelectorAll("button[aria-pressed=\"true\"]"))
            .map((button) => (button.textContent || "").trim().toLowerCase())
            .find((text) => text === "moving" || text === "no move" || text === "nmpz");
        const selectedStreet = Array.from(modal.querySelectorAll("button[aria-pressed=\"true\"]"))
            .map((button) => (button.textContent || "").trim().toLowerCase())
            .find((text) => text === "shown" || text === "hidden");
        const ruleset = selectedMode === "no move" ? "no_move" : selectedMode === "nmpz" ? "nmpz" : "moving";
        const streetNames = selectedStreet === "hidden" ? "hidden" : "shown";
        countryStreakRules = { ruleset, streetNames };
        settings.countryStreakRuleset = ruleset;
        settings.countryStreakStreetNames = streetNames;
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (_) {}
    }

    function getCountryStreakLaunchRules() {
        if (isCompetitionMode()) return { ruleset: COMPETITION_RULESET, streetNames: COMPETITION_STREET_NAMES };
        const config = latestMatchConfig || latestSnapshot?.config || {};
        const ruleset = ["moving", "no_move", "nmpz"].includes(config.ruleset)
            ? config.ruleset
            : countryStreakRules.ruleset;
        const streetNames = config.streetNames === "hidden" || config.streetNames === "shown"
            ? config.streetNames
            : countryStreakRules.streetNames;
        return { ruleset, streetNames };
    }

    function findHomePlayGrid() {
        const candidates = Array.from(document.querySelectorAll(".lobby-feature-card"));
        const singleplayer = candidates.find((card) => (card.textContent || "").toLowerCase().includes("singleplayer"));
        if (!singleplayer) return null;
        const grid = singleplayer.closest(".grid");
        if (grid && candidates.filter((card) => grid.contains(card)).length >= 2) return grid;
        const parent = singleplayer.parentElement;
        return parent && parent.children.length >= 2 ? parent : null;
    }

    async function openCountryStreakFromHome() {
        const ready = await ensureUnifiedCountryStreakSetup();
        if (!ready) return;
        settings.enabled = true;
        countryStreakRules = { ruleset: settings.countryStreakRuleset, streetNames: settings.countryStreakStreetNames };
        setCountryStreakIntent();
        saveSettings();
        const nativeSingleplayerButton = Array.from(document.querySelectorAll(".lobby-feature-card"))
            .find((card) => (card.textContent || "").toLowerCase().includes("singleplayer"))
            ?.querySelector("button");
        if (nativeSingleplayerButton) nativeSingleplayerButton.click();
    }

    let automaticRestartInFlight = false;

    function autoRestartCountryStreakFromHome() {
        if (automaticRestartInFlight || location.pathname !== "/" && location.pathname !== "") return;
        let restartRules = null;
        try {
            const raw = targetWin.sessionStorage.getItem(FIFTH_FORCE_RETRY_KEY);
            if (!raw) return;
            const pending = JSON.parse(raw);
            if (!pending || Date.now() - Number(pending.createdAt || 0) > AUTO_RESTART_MAX_AGE_MS) {
                targetWin.sessionStorage.removeItem(FIFTH_FORCE_RETRY_KEY);
                return;
            }
            restartRules = {
                ruleset: ["moving", "no_move", "nmpz"].includes(pending.ruleset) ? pending.ruleset : "moving",
                streetNames: pending.streetNames === "hidden" ? "hidden" : "shown"
            };
        } catch (_) { return; }
        if (!restartRules) return;
        automaticRestartInFlight = true;
        settings.enabled = true;
        settings.countryStreakRuleset = restartRules.ruleset;
        settings.countryStreakStreetNames = restartRules.streetNames;
        countryStreakRules = { ...restartRules };
        setCountryStreakIntent();
        saveSettings();
        const deadline = Date.now() + 10000;
        const step = () => {
            const cardButton = document.querySelector("#gd-country-streak-home-play");
            if (!cardButton) {
                if (Date.now() < deadline) targetWin.setTimeout(step, 40);
                else automaticRestartInFlight = false;
                return;
            }
            cardButton.click();
            const modal = findPlayModal();
            if (!modal) {
                if (Date.now() < deadline) targetWin.setTimeout(step, 60);
                else automaticRestartInFlight = false;
                return;
            }
            const modeLabel = restartRules.ruleset === "no_move" ? "no move" : restartRules.ruleset;
            const modeButton = findLaunchOptionButton(modal, modeLabel);
            const streetButton = findLaunchOptionButton(modal, restartRules.streetNames);
            if (modeButton && !isLaunchOptionSelected(modeButton)) modeButton.click();
            if (streetButton && !isLaunchOptionSelected(streetButton)) streetButton.click();
            const startButton = Array.from(modal.querySelectorAll("button")).find((button) => (button.textContent || "").trim().toLowerCase() === "start");
            if (startButton) {
                startButton.dataset.gdAllowAutomaticCountryStreakStart = "true";
                startButton.click();
                try { targetWin.sessionStorage.removeItem(FIFTH_FORCE_RETRY_KEY); } catch (_) {}
                return;
            }
            if (Date.now() < deadline) targetWin.setTimeout(step, 60);
            else automaticRestartInFlight = false;
        };
        targetWin.setTimeout(step, 80);
    }

    function injectHomeCountryStreakCard() {
        if (location.pathname !== "/" && location.pathname !== "") return;
        const grid = findHomePlayGrid();
        if (!grid) return;
        grid.id = "gd-country-streak-home-grid";
        if (!countryStreakCardStyleElement) {
            countryStreakCardStyleElement = document.createElement("style");
            countryStreakCardStyleElement.textContent = `#gd-country-streak-home-grid{grid-template-columns:minmax(0,1fr)!important;}@media (min-width:640px){#gd-country-streak-home-grid{grid-template-columns:minmax(0,1fr)!important;}}@media (min-width:1024px){#gd-country-streak-home-grid{grid-template-columns:repeat(3,minmax(0,1fr))!important;}}`;
            (document.head || document.documentElement).appendChild(countryStreakCardStyleElement);
        }
        if (grid.querySelector("#gd-country-streak-home-card")) return;
        countryStreakCard = document.createElement("section");
        countryStreakCard.id = "gd-country-streak-home-card";
        countryStreakCard.className = "glass-panel text-[#f4f9ff] rounded-2xl lobby-feature-card relative flex min-h-[165px] w-full flex-col gap-4 p-4 transition-colors duration-500 sm:min-h-[180px] sm:p-5";
        countryStreakCard.style.cssText = "position:relative;overflow:hidden;";
        countryStreakCard.innerHTML = `
            <div style="position:relative;z-index:1;display:flex;flex-direction:column;gap:4px;"><span id="gd-country-streak-card-label" style="display:inline-flex;align-items:center;gap:7px;margin-bottom:4px;color:#8caab0;font-size:12px;font-weight:700;letter-spacing:.16em;line-height:1.2;text-transform:uppercase;"><span>Special Challenge</span></span><h2 style="margin:0;color:#fff;font-size:clamp(32px,3vw,38px);font-weight:800;line-height:1.05;letter-spacing:-.02em;">Country Streak</h2><p style="margin:6px 0 0;color:#a9bfd4;font-size:13px;font-weight:600;line-height:1.35;">Keep your country streak alive. Casual rules or ranked challenge.</p></div>
            <div style="position:relative;z-index:1;margin-top:auto;"><button id="gd-country-streak-home-play" type="button" style="display:inline-flex;width:100%;min-height:54px;align-items:center;justify-content:center;gap:8px;border:1px solid transparent;border-radius:16px;background:#2ad18f;color:#fff;font-size:16px;font-weight:800;letter-spacing:.08em;line-height:1;text-transform:uppercase;box-shadow:0 10px 24px rgba(42,209,143,.28);cursor:pointer;transition:transform .2s,filter .2s;"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"></path></svg>PLAY</button></div>`;
        const playButton = countryStreakCard.querySelector("#gd-country-streak-home-play");
        playButton?.addEventListener("mouseenter", () => { playButton.style.filter = "brightness(1.12)"; playButton.style.transform = "scale(1.01)"; }, true);
        playButton?.addEventListener("mouseleave", () => { playButton.style.filter = ""; playButton.style.transform = ""; }, true);
        playButton?.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); void openCountryStreakFromHome(); }, true);
        grid.appendChild(countryStreakCard);
    }

    function setLeaderboardNameInput(name, options) {
        const normalized = normalizeLeaderboardName(name);
        const input = options?.querySelector("#gd-streak-account-name") || document.getElementById("gd-streak-account-name");
        if (!normalized || !input) return false;
        input.value = normalized;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    }

    async function maybeAskNicknameChoice(options) {
        if (settings.nicknameChoiceAsked || settings.leaderboardAccountName || nicknameChoicePromptPromise) return;
        settings.nicknameChoiceAsked = true;
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
        nicknameChoicePromptPromise = (async () => {
            const session = await fetchGeoDuelsSession();
            const currentName = normalizeLeaderboardName(session?.displayName || "");
            if (currentName) {
                const choice = await showToastCard({
                    title: "Country Streak setup",
                    message: `Use your GeoDuels display name “${currentName}” as your visible leaderboard name? This copies only the name, never your real User ID.`,
                    buttons: [
                        { label: "USE THIS NAME", value: "use", kind: "primary" },
                        { label: "CHOOSE A DIFFERENT NAME", value: "custom" }
                    ],
                    tone: "info"
                });
                if (choice?.action === "use") {
                    setLeaderboardNameInput(currentName, options);
                    showToastNotice(`“${currentName}” is now your visible Country Streak name.`, { title: "Name saved", tone: "success", duration: 3200 });
                    return;
                }
            }
            const custom = await showToastCard({
                title: "Choose a leaderboard name",
                message: "Type any visible name you want to use. Names may repeat; your real GeoDuels User ID is never used.",
                input: { placeholder: "Leaderboard name", maxLength: 48 },
                buttons: [
                    { label: "SAVE NAME", value: "save", kind: "primary" },
                    { label: "LATER", value: "later" }
                ],
                tone: "info"
            });
            if (custom?.action === "save") {
                const name = normalizeLeaderboardName(custom.value || "");
                if (name) {
                    setLeaderboardNameInput(name, options);
                    showToastNotice(`“${name}” is ready for Country Streak.`, { title: "Name saved", tone: "success", duration: 3200 });
                } else {
                    showToastNotice("No name was entered. You can set one later in the Country Streak settings.", { title: "Name not set", tone: "warning" });
                }
            }
        })().finally(() => {
            nicknameChoicePromptPromise = null;
        });
        await nicknameChoicePromptPromise;
    }

    function injectModalToggle() {
        const modal = findPlayModal();
        if (!modal) return;
        if (!hasCountryStreakIntent()) {
            modal.querySelector("#gd-streak-toggle")?.remove();
            modal.querySelector("#gd-streak-options")?.remove();
            return;
        }

        let options = modal.querySelector("#gd-streak-options");
        if (!options) {
            options = document.createElement("div");
            options.id = "gd-streak-options";
            options.style.cssText = "display:grid;gap:9px;margin:0 0 12px;padding:12px 14px;border:1px solid rgba(255,255,255,0.08);border-radius:14px;background:rgba(0,0,0,0.12);color:#dbe7ff;font-size:11px;";
            options.innerHTML = `
                <div style="display:grid;gap:7px;padding:9px 10px;border:1px solid rgba(255,255,255,.09);border-radius:10px;background:rgba(0,0,0,.14);">
                    <label for="gd-streak-account-name" style="color:#fff;font-size:12px;font-weight:800;">Leaderboard account name</label>
                    <div style="display:flex;gap:7px;align-items:center;">
                        <input id="gd-streak-account-name" type="text" maxlength="48" autocomplete="off" placeholder="Choose any visible name" style="min-width:0;flex:1;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:rgba(0,0,0,.24);padding:7px 8px;color:#fff;">
                        <button id="gd-use-geo-name" type="button" style="white-space:nowrap;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:rgba(255,255,255,.06);padding:7px 9px;color:#dbe7ff;font-size:10px;font-weight:800;cursor:pointer;">USE CURRENT NICKNAME</button>
                    </div>
                    <button id="gd-show-recovery-id" type="button" style="justify-self:start;border:1px solid rgba(42,209,143,.35);border-radius:8px;background:rgba(42,209,143,.08);padding:7px 9px;color:#b9ffe1;font-size:10px;font-weight:900;cursor:pointer;">SHOW MY RECOVERY ID</button>
                    <span style="color:rgba(255,255,255,.45);font-size:10px;line-height:1.35;">Names may repeat. Your GeoDuels User ID is never used for this leaderboard.</span>
                </div>
                <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;"><span><b style="display:block;color:#fff;font-size:12px;">Competition mode</b><span style="color:rgba(255,255,255,.45);">120 seconds per round · personal-best record only</span></span><span role="radiogroup" aria-label="Competition mode" style="display:inline-flex;flex:0 0 auto;align-items:center;gap:3px;padding:3px;border:1px solid rgba(255,255,255,.12);border-radius:12px;background:rgba(255,255,255,.04);"><label for="gd-streak-competition-off" style="display:inline-flex;align-items:center;gap:4px;padding:7px 9px;border-radius:9px;color:#8caab0;font-size:10px;font-weight:900;line-height:1;cursor:pointer;transition:background .18s,color .18s,box-shadow .18s;"><input id="gd-streak-competition-off" name="gd-streak-competition-mode" value="off" type="radio" style="width:13px;height:13px;margin:0;accent-color:#64748b;">OFF</label><label for="gd-streak-competition-on" style="display:inline-flex;align-items:center;gap:4px;padding:7px 9px;border-radius:9px;color:#8caab0;font-size:10px;font-weight:900;line-height:1;cursor:pointer;transition:background .18s,color .18s,box-shadow .18s;"><input id="gd-streak-competition-on" name="gd-streak-competition-mode" value="on" type="radio" style="width:13px;height:13px;margin:0;accent-color:#2ad18f;">ON</label></span></div>
                <div id="gd-streak-competition-rules" style="padding:9px 10px;border-radius:9px;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.18);color:#f7d889;font-size:11px;line-height:1.5;">Competition rules: Moving + Hide street names. Requires the GeoDuels extension.</div>
                <label style="display:flex;align-items:center;justify-content:space-between;gap:12px;"><span><b style="display:block;color:#fff;font-size:12px;">Practice round limit</b><span style="color:rgba(255,255,255,.45);">0 seconds means unlimited</span></span><input id="gd-streak-practice-seconds" type="number" min="0" max="3600" step="1" style="width:84px;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:rgba(0,0,0,.24);padding:7px 8px;color:#fff;text-align:center;"></label>`;
            const startButton = Array.from(modal.querySelectorAll("button")).find((button) => (button.textContent || "").toLowerCase().includes("start"));
            if (startButton?.parentElement) startButton.parentElement.insertBefore(options, startButton);
            else row.insertAdjacentElement("afterend", options);
            options.querySelector("#gd-streak-account-name")?.addEventListener("change", (event) => {
                const nextName = normalizeLeaderboardName(event.currentTarget.value);
                event.currentTarget.value = nextName;
                if (nextName !== settings.leaderboardAccountName) {
                    leaderboardAccount = null;
                    clearRememberedLeaderboardAccount();
                    settings.leaderboardEnabled = false;
                    settings.leaderboardAccountName = nextName;
                    settings.leaderboardDisplayName = nextName;
                    saveSettings();
                }
            });
            options.querySelector("#gd-use-geo-name")?.addEventListener("click", async (event) => {
                event.preventDefault();
                event.stopPropagation();
                const session = await fetchGeoDuelsSession();
                const currentName = normalizeLeaderboardName(session?.displayName || "");
                const input = options.querySelector("#gd-streak-account-name");
                if (currentName && input) {
                    input.value = currentName;
                    input.dispatchEvent(new Event("change", { bubbles: true }));
                    showToastNotice(`The visible name “${currentName}” was copied into the leaderboard field.`, { title: "Nickname ready", tone: "success", duration: 3200 });
                } else {
                    showToastNotice("GeoDuels did not provide a nickname. You can type any leaderboard name yourself.", { title: "Nickname unavailable", tone: "warning" });
                }
            });
            options.querySelector("#gd-show-recovery-id")?.addEventListener("click", async (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (leaderboardAccount?.recoveryId) {
                    await showRecoveryIdToast(leaderboardAccount.displayName, leaderboardAccount.recoveryId);
                    return;
                }
                const accountName = getConfiguredLeaderboardName();
                if (!accountName) {
                    showToastNotice("Enter a leaderboard account name first.", { title: "Name required", tone: "warning" });
                    return;
                }
                const result = await showToastCard({
                    title: "Show Recovery ID",
                    message: `Enter the Recovery ID for “${accountName}”. It will only be held in memory for this page.`,
                    input: { placeholder: "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX", maxLength: 32 },
                    buttons: [
                        { label: "VERIFY", value: "verify", kind: "primary" },
                        { label: "CANCEL", value: "cancel" }
                    ],
                    tone: "info"
                });
                const recoveryId = normalizeRecoveryId(result?.value || "");
                if (!recoveryId) return;
                try {
                    const accountId = await deriveLeaderboardAccountId(accountName, recoveryId);
                    if (!(await leaderboardAccountExists(accountName, accountId))) {
                        showToastNotice("That Recovery ID does not match this leaderboard account. No new account was created.", { title: "Recovery ID not matched", tone: "error", duration: 6200 });
                        return;
                    }
                    activateLeaderboardAccount(accountName, accountId, recoveryId);
                    await showRecoveryIdToast(accountName, recoveryId, "Recovery ID verified");
                } catch (error) {
                    showToastNotice(`Unable to verify the Recovery ID: ${String(error?.message || error)}`, { title: "Recovery verification failed", tone: "error", duration: 7200 });
                }
            });
            options.querySelectorAll('input[name="gd-streak-competition-mode"]').forEach((radio) => radio.addEventListener("change", async (event) => {
                const requested = event.currentTarget.value === "on";
                if (!requested) {
                    settings.competitionMode = false;
                    saveSettings();
                    updateSettingsControls();
                    return;
                }
                settings.competitionMode = true;
                updateSettingsControls();
                const accepted = await ensureUnifiedCountryStreakSetup();
                if (!accepted) {
                    settings.competitionMode = false;
                    saveSettings();
                    updateSettingsControls();
                    return;
                }
                saveSettings();
                updateSettingsControls();
            }, true));
            options.querySelector("#gd-streak-practice-seconds")?.addEventListener("change", (event) => {
                settings.practiceSeconds = clampInteger(event.currentTarget.value, 0, MAX_PRACTICE_SECONDS);
                saveSettings();
            });
        }
        enforceCompetitionLaunchRules(modal);
        applyCompetitionOptionStyles(modal);
        installCompetitionStartGuard(modal);
        updateSettingsControls();
        // Account setup is opened only through the shared coordinator from
        // Country Streak or Streaks, never as a second automatic prompt.

    }

    function updateSettingsControls() {
        const switchElement = document.getElementById("gd-streak-switch");
        const knob = document.getElementById("gd-streak-switch-knob");
        if (switchElement) switchElement.style.background = settings.enabled ? "#10b981" : "rgba(255,255,255,0.2)";
        if (knob) knob.style.left = settings.enabled ? "20px" : "2px";
        const accountNameInput = document.getElementById("gd-streak-account-name");
        if (accountNameInput && document.activeElement !== accountNameInput) accountNameInput.value = settings.leaderboardAccountName || settings.leaderboardDisplayName || "";
        const competitionOn = document.getElementById("gd-streak-competition-on");
        const competitionOff = document.getElementById("gd-streak-competition-off");
        if (competitionOn) competitionOn.checked = settings.competitionMode;
        if (competitionOff) competitionOff.checked = !settings.competitionMode;
        const competitionOnLabel = document.querySelector('label[for="gd-streak-competition-on"]');
        const competitionOffLabel = document.querySelector('label[for="gd-streak-competition-off"]');
        if (competitionOnLabel) {
            competitionOnLabel.style.background = settings.competitionMode ? "rgba(42,209,143,.22)" : "transparent";
            competitionOnLabel.style.color = settings.competitionMode ? "#fff" : "#8caab0";
            competitionOnLabel.style.boxShadow = settings.competitionMode ? "0 4px 14px rgba(42,209,143,.18)" : "none";
        }
        if (competitionOffLabel) {
            competitionOffLabel.style.background = settings.competitionMode ? "transparent" : "rgba(255,255,255,.10)";
            competitionOffLabel.style.color = settings.competitionMode ? "#8caab0" : "#fff";
            competitionOffLabel.style.boxShadow = settings.competitionMode ? "none" : "0 4px 14px rgba(0,0,0,.16)";
        }
        const seconds = document.getElementById("gd-streak-practice-seconds");
        if (seconds) {
            seconds.value = String(settings.practiceSeconds);
            seconds.disabled = settings.competitionMode;
            seconds.style.opacity = settings.competitionMode ? "0.45" : "1";
        }
        const rules = document.getElementById("gd-streak-competition-rules");
        if (rules) {
            rules.textContent = settings.competitionMode
                ? "Competition rules: Moving + Hide street names. Requires the GeoDuels extension."
                : "Casual Country Streak: choose Moving, No Move, NMPZ, and Shown or Hidden street names. No Move and Hidden require the official extension.";
        }
        const modal = findPlayModal();
        if (modal) {
            enforceCompetitionLaunchRules(modal);
            applyCompetitionOptionStyles(modal);
            installCompetitionStartGuard(modal);
        }
    }

    async function fetchLeaderboardRows() {
        leaderboardLoading = true;
        renderLeaderboardPanel();
        const headers = { apikey: SUPABASE_PUBLISHABLE_KEY };
        try {
            const response = await targetWin.fetch(`${SUPABASE_URL}/rest/v1/country_streak_leaderboard?select=rank,user_id,display_name,best_streak,latest_final_streak,total_matches,total_correct,updated_at&order=rank.asc&limit=100`, { headers, cache: "no-store" });
            if (!response.ok) throw new Error(`Leaderboard unavailable (${response.status})`);
            leaderboardRows = await response.json();
        } catch (error) {
            console.error("[GeoDuels Country Streak] leaderboard load failed", error);
            leaderboardRows = [];
        } finally {
            leaderboardLoading = false;
            renderLeaderboardPanel();
        }
    }

    function navigateLeaderboardToHome() {
        if (leaderboardPanel) {
            leaderboardPanel.style.display = "none";
            leaderboardPanel.replaceChildren();
        }
        leaderboardHistoryEntryPushed = false;
        clearCountryStreakIntent();
        clearCompetitionLaunchIntent();
        isSingleplayer = false;
        latestSnapshot = null;
        removeHUD();
        removeGameOverOverlay();
        removeCountryStreakStageOverlay();
        removeCountryStreakMatchEndHUD();
        const cleanPlayUrl = "https://geoduels.io/";
        // Do not use hash/history navigation here: the leaderboard is a userscript
        // overlay and a full reload is required to clear the official game state.
        try {
            targetWin.location.assign(cleanPlayUrl);
        } catch (_) {
            window.location.assign(cleanPlayUrl);
        }
    }

    function installLeaderboardBackHandler() {
        if (leaderboardBackHandlerInstalled) return;
        leaderboardBackHandlerInstalled = true;
        document.addEventListener("click", (event) => {
            const target = event.target instanceof Element ? event.target.closest("#gd-leaderboard-back") : null;
            if (!target) return;
            // Let the anchor's native href perform the navigation; do not cancel
            // the first click or depend on a render-specific listener.
            target.setAttribute("href", "https://geoduels.io/");
        }, true);
    }

    function renderLeaderboardPanel() {
        if (!leaderboardPanel) return;
        const rowsHTML = leaderboardLoading
            ? `<div style="padding:42px;text-align:center;color:#a9bfd4;">Loading leaderboard...</div>`
            : leaderboardRows.length
                ? leaderboardRows.map((row, index) => {
                    const rank = Number(row.rank) || index + 1;
                    const isCurrent = !!leaderboardAccount?.accountId && String(row.user_id || "") === leaderboardAccount.accountId;
                    const rankColor = rank <= 3 ? "#9de4c1" : "#8caab0";
                    return `<div style="display:grid;grid-template-columns:50px minmax(0,1fr) 92px 92px 86px;align-items:center;gap:12px;padding:12px 12px;border-top:1px solid rgba(255,255,255,.07);border-radius:12px;background:${isCurrent ? "rgba(24,56,46,.70)" : "transparent"};font-size:13px;">
                        <strong style="display:inline-flex;width:32px;height:26px;align-items:center;justify-content:center;border-radius:999px;background:${rank <= 3 ? "rgba(70,168,115,.20)" : "rgba(255,255,255,.04)"};color:${rankColor};">#${escapeHTML(rank)}</strong>
                        <span style="min-width:0;display:flex;flex-direction:column;gap:2px;overflow:hidden;color:#fff;font-weight:800;"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHTML(row.display_name || "Player")}${isCurrent ? " <em style=\"font-style:normal;color:#77f0be;font-size:10px;font-weight:900;\">You</em>" : ""}</span><small style="color:#a9bfd4;font-size:11px;font-weight:600;">${Number(row.total_matches) || 0} matches</small></span>
                        <span aria-label="Streak" title="Streak" style="text-align:right;color:#77f0be;font-weight:1000;">${Number(row.best_streak) || 0}</span>
                        <span style="text-align:right;color:#dbe7ff;font-weight:800;">${Number(row.total_correct) || 0}</span>
                        <span style="text-align:right;color:#a9bfd4;font-weight:700;">${Number(row.total_matches) || 0}</span>
                    </div>`;
                }).join("")
                : `<div style="padding:42px;text-align:center;color:#a9bfd4;">No valid competition results yet.</div>`;
        const yourRow = leaderboardAccount?.accountId
            ? leaderboardRows.find((row) => String(row.user_id || "") === leaderboardAccount.accountId)
            : null;
        const yourBest = yourRow ? Number(yourRow.best_streak) || 0 : Number(state.competitionBestStreak) || 0;
        const yourRank = yourRow ? Number(yourRow.rank) || "—" : "—";
        leaderboardPanel.innerHTML = `
            <main aria-label="Country Streak Leaderboard" style="position:absolute;inset:0;overflow:auto;overscroll-behavior:contain;padding:24px 14px 42px;background:#070b0f;pointer-events:auto;">
                <div style="width:min(980px,100%);margin:0 auto;">
                    <section style="border:1px solid rgba(255,255,255,.12);border-radius:26px;background:linear-gradient(180deg,rgba(13,30,36,.92),rgba(6,14,19,.94));box-shadow:0 24px 90px rgba(0,0,0,.42);padding:clamp(18px,3vw,26px);">
                        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:18px;">
                            <div style="min-width:0;"><div style="color:#77f0be;font-size:11px;font-weight:900;letter-spacing:.20em;text-transform:uppercase;">Country Streak</div><h1 style="margin:6px 0 0;color:#fff;font-size:clamp(28px,5vw,40px);font-weight:1000;line-height:1.05;">Streak Leaderboard</h1><p style="margin:10px 0 0;color:#a9bfd4;font-size:13px;">STREAK · 120-second competition · personal best</p></div>
                            <div style="display:flex;flex-shrink:0;gap:8px;align-items:stretch;">
                                <div style="min-width:92px;padding:11px 12px;border:1px solid rgba(255,255,255,.08);border-radius:15px;background:rgba(255,255,255,.06);"><div style="color:#8caab0;font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;">Your rank</div><strong style="display:block;margin-top:5px;color:#fff;font-size:25px;line-height:1;">#${escapeHTML(yourRank)}</strong></div>
                                <div style="min-width:92px;padding:11px 12px;border:1px solid rgba(255,255,255,.08);border-radius:15px;background:rgba(255,255,255,.06);"><div style="color:#8caab0;font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;">Your streak</div><strong style="display:block;margin-top:5px;color:#77f0be;font-size:25px;line-height:1;">${escapeHTML(yourBest)}</strong></div>
                            </div>
                        </div>
                        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:24px;padding:0 10px 10px;color:#8caab0;font-size:10px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;"><span>${leaderboardRows.length ? `${leaderboardRows.length} ranked players` : "Ranked players"}</span><span style="margin-left:auto;display:flex;align-items:center;gap:10px;"><a id="gd-leaderboard-back" href="https://geoduels.io/" style="display:inline-flex;min-width:220px;min-height:52px;align-items:center;justify-content:center;gap:9px;border:1px solid rgba(119,240,190,.68);border-radius:14px;background:linear-gradient(135deg,#2ad18f 0%,#109d69 100%);padding:0 26px;color:#fff;font-size:14px;font-weight:1000;letter-spacing:.12em;line-height:1;text-decoration:none;cursor:pointer;box-shadow:0 10px 28px rgba(42,209,143,.28);transition:transform .18s,filter .18s,box-shadow .18s;">← BACK TO HOME</a><button id="gd-leaderboard-refresh" type="button" style="border:0;background:transparent;color:#77f0be;font-size:10px;font-weight:900;letter-spacing:.10em;cursor:pointer;">REFRESH</button></span></div>
                        <div style="overflow-x:auto;"><div style="min-width:560px;"><div style="display:grid;grid-template-columns:50px minmax(0,1fr) 92px 92px 86px;gap:12px;padding:0 12px 8px;color:#8caab0;font-size:10px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;"><span>Rank</span><span>Player</span><span style="text-align:right;">Streak</span><span style="text-align:right;">Correct</span><span style="text-align:right;">Matches</span></div>${rowsHTML}</div></div>
                    </section>
                </div>
            </main>`;
        // BACK TO HOME is a real same-tab URL link; do not intercept it here.
        // The browser's native navigation handles the first click reliably.

        const backButton = leaderboardPanel.querySelector("#gd-leaderboard-back");
        const goHomeFromLeaderboard = (event) => {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            clearCountryStreakIntent();
            clearCompetitionLaunchIntent();
            const homeUrl = "https://geoduels.io/";
            try { targetWin.location.replace(homeUrl); } catch (_) {
                try { targetWin.location.href = homeUrl; } catch (_) { window.open(homeUrl, "_self"); }
            }
            targetWin.setTimeout(() => {
                if (targetWin.location.href !== homeUrl && !targetWin.location.pathname.endsWith("/")) {
                    try { targetWin.location.href = homeUrl; } catch (_) { window.open(homeUrl, "_self"); }
                }
            }, 120);
        };
        // Bind directly to the freshly rendered element. pointerdown prevents
        // page-level React handlers from swallowing the first click.
        backButton?.addEventListener("pointerdown", goHomeFromLeaderboard, true);
        backButton?.addEventListener("click", goHomeFromLeaderboard, true);
        backButton?.addEventListener("mouseenter", () => { backButton.style.filter = "brightness(1.10)"; backButton.style.transform = "translateY(-1px)"; backButton.style.boxShadow = "0 13px 32px rgba(42,209,143,.38)"; }, true);
        backButton?.addEventListener("mouseleave", () => { backButton.style.filter = ""; backButton.style.transform = ""; backButton.style.boxShadow = "0 10px 28px rgba(42,209,143,.28)"; }, true);
        leaderboardPanel.querySelector("#gd-leaderboard-refresh")?.addEventListener("click", () => void fetchLeaderboardRows(), true);
    }

    function openLeaderboardPanel() {
        if (!document.body) return;
        const wasClosed = !leaderboardPanel || leaderboardPanel.style.display === "none";
        if (!leaderboardPanel) {
            leaderboardPanel = document.createElement("div");
            leaderboardPanel.id = "gd-country-streak-leaderboard";
            leaderboardPanel.style.cssText = "position:fixed;inset:0;z-index:2147483000;display:block;overflow:hidden;background:#070b0f;pointer-events:auto;";
            document.body.appendChild(leaderboardPanel);
        }
        if (wasClosed && location.hash !== "#country-streak-leaderboard") {
            targetWin.history.pushState({ gdCountryStreakLeaderboard: true }, "", `${location.pathname}${location.search}#country-streak-leaderboard`);
            leaderboardHistoryEntryPushed = true;
        }
        leaderboardPanel.style.display = "block";
        renderLeaderboardPanel();
        if (wasClosed) void fetchLeaderboardRows();
    }

    function closeLeaderboardPanel() {
        navigateLeaderboardToHome();
    }

    function injectLeaderboardTab() {
        if (location.pathname !== "/" && location.pathname !== "") return;
        const nav = Array.from(document.querySelectorAll("nav")).find((candidate) => {
            const text = (candidate.textContent || "").toLowerCase();
            return text.includes("play") && (text.includes("top") || text.includes("maps"));
        });
        if (!nav) return;
        if (!leaderboardTab || !document.body.contains(leaderboardTab)) {
            leaderboardTab = document.createElement("a");
            leaderboardTab.id = "gd-country-streak-tab";
            leaderboardTab.href = "#country-streak-leaderboard";
            leaderboardTab.setAttribute("aria-label", "Streaks");
            leaderboardTab.title = "Streaks";
            leaderboardTab.innerHTML = `<span aria-hidden="true" style="display:inline-flex;width:17px;height:17px;align-items:center;justify-content:center;color:#fff;line-height:1;font-size:16px;">✦</span><span style="display:inline-block;line-height:1;">Streaks</span>`;
            leaderboardTab.style.cssText = "position:relative;display:inline-flex;width:max-content;min-width:0;max-width:92px;height:36px;min-height:36px;align-self:center;align-items:center;justify-content:center;gap:5px;padding:0 8px;box-sizing:border-box;border-radius:11px;color:#8fa7af;text-decoration:none;font-size:9px;font-weight:900;line-height:1;white-space:nowrap;text-align:center;overflow:hidden;transition:color .2s,background .2s;";
            leaderboardTab.addEventListener("mouseenter", () => { leaderboardTab.style.color = "#fff"; leaderboardTab.style.background = "rgba(255,255,255,.08)"; }, true);
            leaderboardTab.addEventListener("mouseleave", () => { leaderboardTab.style.color = "#8fa7af"; leaderboardTab.style.background = "transparent"; }, true);
            leaderboardTab.addEventListener("click", async (event) => {
                event.preventDefault();
                event.stopPropagation();
                const accepted = await ensureUnifiedCountryStreakSetup();
                if (accepted) openLeaderboardPanel();
            }, true);
        }
        if (!nav.contains(leaderboardTab)) nav.appendChild(leaderboardTab);
        nav.style.gridTemplateColumns = `repeat(${nav.children.length}, minmax(0, 1fr))`;
    }

    function handleLeaderboardHash() {
        const wantsLeaderboard = location.hash === "#country-streak-leaderboard";
        if (wantsLeaderboard && (settings.leaderboardEnabled || leaderboardAccount?.accountId)) {
            openLeaderboardPanel();
            return;
        }
        if (wantsLeaderboard) {
            if (!leaderboardHashSetupPromise) {
                leaderboardHashSetupPromise = ensureUnifiedCountryStreakSetup().then((accepted) => {
                    if (accepted && location.hash === "#country-streak-leaderboard") openLeaderboardPanel();
                    else if (!accepted && location.hash === "#country-streak-leaderboard") targetWin.history.replaceState(null, "", `${location.origin}/`);
                }).finally(() => {
                    leaderboardHashSetupPromise = null;
                });
            }
            return;
        }
        if (leaderboardPanel && leaderboardPanel.style.display !== "none") {
            leaderboardPanel.style.display = "none";
            leaderboardHistoryEntryPushed = false;
        }
    }

    function sendVisibilityRecoveryPing() {
        if (!isInSingleplayer() || !activeSocket || activeSocket.readyState !== WebSocket.OPEN) return;
        try {
            activeSocket.send(JSON.stringify({
                commandId: `gd-visibility-ping-${Date.now()}`,
                type: "ping",
                payload: { userId: sessionCache?.userId || "" },
                sentAt: Date.now()
            }));
        } catch (_) {}
    }

    function handlePageVisible() {
        if (document.visibilityState !== "visible") return;
        if (isInSingleplayer()) {
            sendVisibilityRecoveryPing();
            requestTick();
            targetWin.setTimeout(() => {
                sendVisibilityRecoveryPing();
                requestTick();
            }, 450);
        }
    }

    let tickScheduled = false;
    function requestTick() {
        if (!reactHydrationSettled || tickScheduled) return;
        tickScheduled = true;
        requestAnimationFrame(() => {
            tickScheduled = false;
            if (latestSnapshot?.phase === "live" && latestSnapshot?.roundPhase === "round_live") setCountryStreakInitialFrameLock(false);
            else if (getCountryStreakStage(latestSnapshot)) {
                setCountryStreakInitialFrameLock(false);
                hideNativeResultScore();
            }
            if (isCountryStreakLiveRound()) {
                removeCountryStreakLoadingOverlay();
                ensureHUD();
            } else removeHUD();
            injectHomeCountryStreakCard();
            autoRestartCountryStreakFromHome();
            injectModalToggle();
            injectLeaderboardTab();
            patchEndScreen();
            refreshOfficialResultButtons();
            if (isCountryStreakFailureActive()) hideNativeNextRoundDuringFailureTransition();
            patchPendingEvaluationNextRoundEvent();
            const playModal = findPlayModal();
            rememberCountryStreakRules(playModal);
            if (pendingInitialLiveSnapshot) {
                latestSnapshot = pendingInitialLiveSnapshot;
                pendingInitialLiveSnapshot = null;
            }
            if (latestSnapshot?.phase === "live" && latestSnapshot?.roundPhase === "round_live") {
                updateRoundTimerFromSnapshot(latestSnapshot);
                renderRoundTimer();
                initialTimerSyncDone = true;
            }
            if (isInSingleplayer() && !sessionCache && !avatarLookupRequested) {
                avatarLookupRequested = true;
                void fetchGeoDuelsSession().then(() => requestTick());
            }
            patchSelfGuessMarkerAvatar();
            renderHUD();
            applyHUDVisibility();
            handleLeaderboardHash();
        });
    }

    function init() {
        // Clear any pending state from older homepage-based versions. This
        // version never auto-opens the homepage or shows a custom loader.
        removeCountryStreakLoadingOverlay();
        installCountryStreakInitialFrameGuard();
        startStandaloneTimerLoop();
        patchHistory();
        window.addEventListener("hashchange", handleLeaderboardHash);
        window.addEventListener("popstate", handleLeaderboardHash);
        document.addEventListener("visibilitychange", handlePageVisible, { passive: true });
        window.addEventListener("pageshow", handlePageVisible, { passive: true });
        window.addEventListener("online", handlePageVisible, { passive: true });
        const resultLockStyle = document.createElement("style");
        resultLockStyle.id = "gd-country-streak-result-lock-style";
        resultLockStyle.textContent = `.gd-country-streak-result-lock [class*="right-3"][class*="top-3"][class*="z-30"] { display:none !important; visibility:hidden !important; pointer-events:none !important; }`;
        (document.head || document.documentElement).appendChild(resultLockStyle);
        const matchEndLockStyle = document.createElement("style");
        matchEndLockStyle.id = "gd-country-streak-match-end-lock-style";
        matchEndLockStyle.textContent = `.gd-country-streak-match-end-lock [class*="app-layer-match-end"]:not(#gd-game-over-overlay), .gd-country-streak-match-end-lock [class*="match-end"]:not(#gd-game-over-overlay) { display:none !important; visibility:hidden !important; pointer-events:none !important; }`;
        (document.head || document.documentElement).appendChild(matchEndLockStyle);
        const failureLockStyle = document.createElement("style");
        failureLockStyle.id = "gd-country-streak-failure-lock-style";
        failureLockStyle.textContent = `.gd-country-streak-failure-lock [class*="app-layer-match-end"]:not(#gd-game-over-overlay), .gd-country-streak-failure-lock [class*="match-end"]:not(#gd-game-over-overlay) { display:none !important; pointer-events:none !important; }`;
        (document.head || document.documentElement).appendChild(failureLockStyle);
        installFailureNextRoundBlocker();
        installFailureTransitionObserver();
        installLeaderboardBackHandler();
        installFifthRoundClickFallback();

        const startAfterHydration = () => {
            targetWin.setTimeout(() => {
                const start = () => {
                    reactHydrationSettled = true;
                    if (pendingInitialLiveSnapshot) {
                        latestSnapshot = pendingInitialLiveSnapshot;
                        pendingInitialLiveSnapshot = null;
                    }
                    if (latestSnapshot?.phase === "live" && latestSnapshot?.roundPhase === "round_live") {
                        updateRoundTimerFromSnapshot(latestSnapshot);
                        renderRoundTimer();
                        initialTimerSyncDone = true;
                    }
                    applyHUDVisibility();
                    new MutationObserver(requestTick).observe(document.documentElement, { childList: true, subtree: true });
                    requestTick();
                };
                const raf = targetWin.requestAnimationFrame;
                if (typeof raf === "function") {
                    raf.call(targetWin, () => raf.call(targetWin, start));
                } else {
                    targetWin.setTimeout(start, 32);
                }
            }, REACT_HYDRATION_DELAY_MS);
        };

        if (document.readyState === "complete") startAfterHydration();
        else targetWin.addEventListener("load", startAfterHydration, { once: true });
    }

    installCountryStreakInitialFrameGuard();
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
    else init();
})();
