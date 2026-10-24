// This deliberately has NO network calls, persistence, URL parameters or
// external libraries. The key is created locally using Web Crypto on HTTPS.
export function generateEncryptionKey() {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random generation is unavailable in this browser.");
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

if (typeof document !== "undefined") {
  const generateButton = document.getElementById("generate-key");
  const section = document.getElementById("generated-section");
  const input = document.getElementById("generated-key");
  const copy = document.getElementById("copy-key");
  const status = document.getElementById("key-status");

  generateButton.addEventListener("click", () => {
    try {
      const value = generateEncryptionKey();
      if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("Unexpected key format.");
      input.value = value;
      section.hidden = false;
      status.textContent = "Generated securely. Copy this key and store a backup before leaving this page.";
    } catch {
      input.value = "";
      section.hidden = true;
      window.alert("Secure key generation is unavailable. Use a modern browser over HTTPS.");
    }
  });

  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(input.value);
      status.textContent = "Copied. Return to the Netlify tab and paste the key into Value.";
    } catch {
      input.focus();
      input.select();
      status.textContent = "Copy unavailable automatically. Select and copy the highlighted key manually.";
    }
  });
}
