/* global window, document, URL, URLSearchParams */
// ===== DEMO ACCOUNTS =====
// Shows the demo accounts under the "Sign in" button of every entry's login page, so a visitor can try each role
// without hopping between entries: clicking an account signs in (and, if the account belongs to another entry or company,
// goes to that entry's login page first and signs in there).
// To remove it: delete this file and the "scripts=" line in ../../theme.properties.
function startDemoAccounts() {
  "use strict";
  var PASSWORD = "Demo!Passw0rd2026";
  var GROUPS = [
    { company: "StarIT (hq)", host: "hq", realm: "tenant-hq", accounts: [
      { u: "demo.admin", entry: "admin", label: "Administrator with every permission" },
      { u: "demo.registrar", entry: "admin", label: "Academic office" },
      { u: "demo.teacher", entry: "admin", label: "Teacher" },
      { u: "demo.student1", entry: "portal", label: "Student" },
      { u: "demo.student2", entry: "portal", label: "Student" }
    ] },
    { company: "StarIT RiverSide (franchise)", host: "riverside-franchise", realm: "tenant-riverside-franchise", accounts: [
      { u: "rv.admin", entry: "admin", label: "Administrator with every permission" },
      { u: "rv.registrar", entry: "admin", label: "Academic office" },
      { u: "rv.teacher", entry: "admin", label: "Teacher" },
      { u: "rv.student1", entry: "portal", label: "Student" },
      { u: "rv.student2", entry: "portal", label: "Student" }
    ] },
    { company: "Platform operator", host: "platform", realm: "platform", accounts: [
      { u: "demo.operator", entry: "platform", label: "Platform console" }
    ] }
  ];
  var KEY = "staredu-demo-pick";

  var params = new URLSearchParams(window.location.search);
  var match = /\/realms\/([^/]+)\//.exec(window.location.pathname);
  var realm = match ? match[1] : "";
  var client = params.get("client_id") || "";
  var redirect = params.get("redirect_uri") || "";
  var form = document.getElementById("kc-form-login") || document.querySelector("form");
  if (!form || !document.getElementById("username")) return;

  function submitAs(user) {
    document.getElementById("username").value = user;
    var pw = document.getElementById("password");
    if (pw) pw.value = PASSWORD;
    var button = document.getElementById("kc-login") || form.querySelector("[type=submit]");
    if (button) button.click(); else form.submit();
  }

  // Arrived here from another entry with an account picked: sign in now.
  try {
    var pick = JSON.parse(window.sessionStorage.getItem(KEY) || "null");
    if (pick && Date.now() - pick.at < 120000 && pick.realm === realm) {
      window.sessionStorage.removeItem(KEY);
      submitAs(pick.u);
      return;
    }
  } catch { /* ignore */ }

  function targetUrl(group, account) {
    var origin;
    try { origin = new URL(redirect); } catch { return null; }
    var rest = origin.host.split(".").slice(1).join(".");
    var host = group.host + (rest ? "." + rest : "");
    var path = account.entry === "admin" ? "/admin" : "/";
    return origin.protocol + "//" + host + path;
  }

  function choose(group, account) {
    if (group.realm === realm && account.entry === client) { submitAs(account.u); return; }
    var url = targetUrl(group, account);
    if (!url) { submitAs(account.u); return; }
    try { window.sessionStorage.setItem(KEY, JSON.stringify({ u: account.u, realm: group.realm, at: Date.now() })); } catch { /* ignore */ }
    window.location.assign(url);
  }

  var box = document.createElement("div");
  box.setAttribute("data-demo-accounts", "");
  box.style.cssText = "margin-top:24px;padding:12px 14px;border:1px dashed #b45309;border-radius:6px;background:#fffbeb;color:#451a03;font-size:13px;line-height:1.4;";
  var note = document.createElement("p");
  note.style.cssText = "margin:0 0 8px;font-weight:600;";
  note.textContent = "The accounts below are for demonstration only.";
  box.appendChild(note);
  var pwNote = document.createElement("p");
  pwNote.style.cssText = "margin:0 0 8px;";
  pwNote.textContent = "Click one to sign in. Password for all of them: " + PASSWORD;
  box.appendChild(pwNote);
  GROUPS.forEach(function (group) {
    var title = document.createElement("div");
    title.style.cssText = "margin:8px 0 4px;font-weight:600;";
    title.textContent = group.company;
    box.appendChild(title);
    var row = document.createElement("div");
    row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;";
    group.accounts.forEach(function (account) {
      var b = document.createElement("button");
      b.type = "button";
      b.title = account.label;
      b.textContent = account.u;
      b.style.cssText = "padding:3px 8px;border:1px solid #b45309;border-radius:4px;background:#fff;color:#451a03;cursor:pointer;font-size:12px;";
      b.addEventListener("click", function () { choose(group, account); });
      row.appendChild(b);
    });
    box.appendChild(row);
  });
  var holder = form.parentNode;
  holder.insertBefore(box, form.nextSibling);
}
// The script is loaded in <head>, before the form exists.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startDemoAccounts); else startDemoAccounts();
