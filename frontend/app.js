const apiStatus = document.querySelector("#api-status");

async function checkApi() {
  try {
    const response = await fetch("/api/health", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const result = await response.json();
    apiStatus.textContent = result.status === "ok" ? "API connected" : "API status unknown";
    apiStatus.classList.toggle("is-online", result.status === "ok");
    apiStatus.classList.toggle("is-offline", result.status !== "ok");
  } catch {
    apiStatus.textContent = "API unavailable";
    apiStatus.classList.add("is-offline");
  }
}

checkApi();
