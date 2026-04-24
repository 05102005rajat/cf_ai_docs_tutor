const messagesEl = document.getElementById("messages");
const form = document.getElementById("form");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");

const sessionId = getOrCreateSession();

function getOrCreateSession() {
  const key = "docs_tutor_session";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

function prettyHost(url) {
  try {
    const u = new URL(url);
    return u.hostname + u.pathname;
  } catch {
    return url;
  }
}

function renderSources(container, sources) {
  if (!sources || sources.length === 0) return;
  const seen = new Set();
  const block = document.createElement("div");
  block.className = "sources";
  const label = document.createElement("div");
  label.className = "sources-label";
  label.textContent = "Sources";
  block.appendChild(label);
  for (const s of sources) {
    if (!s.url || seen.has(s.url)) continue;
    seen.add(s.url);
    const a = document.createElement("a");
    a.href = s.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = `[${s.n}] ${prettyHost(s.url)}`;
    block.appendChild(a);
  }
  container.appendChild(block);
}

function addMessage(role, content, sources) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  const body = document.createElement("div");
  body.className = "msg-body";
  body.textContent = content;
  div.appendChild(body);
  if (role === "assistant") renderSources(div, sources);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return { container: div, body };
}

async function loadHistory() {
  try {
    const resp = await fetch(`/chat?session=${sessionId}`);
    const data = await resp.json();
    for (const m of data.messages ?? []) {
      if (m.role === "user" || m.role === "assistant") {
        addMessage(m.role, m.content, m.sources);
      }
    }
  } catch (err) {
    console.error("Failed to load history", err);
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  addMessage("user", text);
  input.value = "";
  sendBtn.disabled = true;

  const thinking = addMessage("assistant", "Thinking...");

  try {
    const resp = await fetch(`/chat?session=${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    const data = await resp.json();
    thinking.body.textContent = data.reply ?? "(empty response)";
    renderSources(thinking.container, data.sources);
  } catch (err) {
    thinking.body.textContent = `Error: ${err.message}`;
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
});

loadHistory();
