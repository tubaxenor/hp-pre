// Deploy-time configuration. Replace GAS_URL with the Apps Script
// web app /exec URL after deploying the backend.
window.APP_CONFIG = {
  GAS_URL: "https://script.google.com/macros/s/AKfycbw8bBU4yHxt6TMGWjN5-_dSbB1Zamd0NXqN478Hq6A95OG9SZcjmLbGmjKYRPNtw5tgYQ/exec",
  // Shown on the "not started yet" screen while ELECTION_STATUS is CLOSED.
  // Split on "～" renders start / end on separate lines.
  VOTE_WINDOW: "2026/08/27 20:00 ～ 2026/08/29 11:00",
  // Shows a "測試" badge by the title. Set false for the real election.
  TEST_MODE: false,
};
