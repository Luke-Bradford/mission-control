/** Keyboard hints (catalogue §1.2; `s Setup` added, §7.6). */
export function Footer() {
  return (
    <footer className="keys">
      <span>
        <kbd>g</kbd> then <kbd>o</kbd> <kbd>f</kbd> <kbd>b</kbd> <kbd>a</kbd> <kbd>c</kbd>{" "}
        <kbd>t</kbd> pages · <kbd>s</kbd> Setup
      </span>
      <span>
        <kbd>f</kbd> FLIGHT
      </span>
      <span>
        <kbd>j</kbd>
        <kbd>k</kbd> next agent
      </span>
      <span>
        <kbd>/</kbd> message agent
      </span>
      <span>
        <kbd>i</kbd> interrupt
      </span>
      <span>
        <kbd>?</kbd> help
      </span>
    </footer>
  );
}
