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

function addMessage(role, content) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = content;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

async function loadHistory() {
  try {
    const resp = await fetch(`/chat?session=${sessionId}`);
    const data = await resp.json();
    for (const m of data.messages ?? []) {
      if (m.role === "user" || m.role === "assistant") {
        addMessage(m.role, m.content);
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
    thinking.textContent = data.reply ?? "(empty response)";
  } catch (err) {
    thinking.textContent = `Error: ${err.message}`;
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
});

loadHistory();
