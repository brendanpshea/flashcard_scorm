// Minimal SCORM 2004 wrapper. Falls back to a localStorage-backed stub
// when no LMS API is present, so the package works via direct file:// launch.

(function (global) {
  function findAPI(win) {
    let tries = 0;
    while (win && tries < 10) {
      if (win.API_1484_11) return win.API_1484_11;
      if (win.parent && win.parent !== win) { win = win.parent; tries++; continue; }
      break;
    }
    try {
      if (window.opener && window.opener.API_1484_11) return window.opener.API_1484_11;
    } catch (_) {}
    return null;
  }

  const realAPI = findAPI(window);
  const LS_KEY = "flashcard_scorm_stub_v1";

  function makeStub() {
    let data = {};
    try { data = JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch (_) {}
    return {
      _stub: true,
      Initialize: () => "true",
      Terminate: () => { localStorage.setItem(LS_KEY, JSON.stringify(data)); return "true"; },
      GetValue: (k) => data[k] || "",
      SetValue: (k, v) => { data[k] = String(v); return "true"; },
      Commit: () => { localStorage.setItem(LS_KEY, JSON.stringify(data)); return "true"; },
      GetLastError: () => "0",
      GetErrorString: () => "",
      GetDiagnostic: () => ""
    };
  }

  const api = realAPI || makeStub();
  let initialized = false;

  const SCORM = {
    isStub: !realAPI,
    init() {
      if (initialized) return true;
      initialized = api.Initialize("") === "true";
      return initialized;
    },
    get(key) { return api.GetValue(key); },
    set(key, val) { return api.SetValue(key, val) === "true"; },
    commit() { return api.Commit("") === "true"; },
    terminate() {
      if (!initialized) return true;
      api.Commit("");
      const ok = api.Terminate("") === "true";
      initialized = false;
      return ok;
    },
    getSuspendData() {
      const raw = api.GetValue("cmi.suspend_data") || "";
      if (!raw) return null;
      try { return JSON.parse(raw); } catch (_) { return null; }
    },
    setSuspendData(obj) {
      api.SetValue("cmi.suspend_data", JSON.stringify(obj));
    },
    setScore(scaled01) {
      const clamped = Math.max(0, Math.min(1, scaled01));
      api.SetValue("cmi.score.scaled", clamped.toFixed(4));
      api.SetValue("cmi.score.raw", Math.round(clamped * 100).toString());
      api.SetValue("cmi.score.min", "0");
      api.SetValue("cmi.score.max", "100");
    },
    setProgress(progress01) {
      const clamped = Math.max(0, Math.min(1, progress01));
      api.SetValue("cmi.progress_measure", clamped.toFixed(4));
    },
    setCompletion(status) { api.SetValue("cmi.completion_status", status); },
    setSuccess(status) { api.SetValue("cmi.success_status", status); }
  };

  global.SCORM = SCORM;
})(window);
