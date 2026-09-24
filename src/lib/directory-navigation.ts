/** Keeps editing intent separate from delayed URL acknowledgements. */
export class DirectoryNavigation {
  private desired: URLSearchParams;
  private draft: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private issued = new Set<string>();
  private submitted: string | undefined;
  private listeners = new Set<() => void>();
  constructor(
    initial: string,
    private navigate: (query: string) => void,
    private view: (value: string) => string | void,
  ) {
    this.desired = new URLSearchParams(initial);
    this.draft = this.desired.get("q") ?? "";
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  snapshot = () => this.draft;
  viewSnapshot = () => this.desired.get("view") === "grid" ? "grid" : "list";
  dispose = () => { clearTimeout(this.timer); };
  private remember(query: string) {
    this.issued.add(query);
    if (this.issued.size > 64) this.issued.delete(this.issued.values().next().value!);
  }
  /** Back/Forward is explicit; our own older responses never replace a newer draft. */
  receive(query: string, history = false) {
    if (!history && this.issued.has(query)) {
      // An in-flight navigation may commit a URL from before the latest local view change.
      if (this.submitted === query) this.submitted = undefined;
      if (!this.submitted) this.reconcileView(query);
      return;
    }
    this.dispose();
    this.submitted = undefined;
    this.desired = new URLSearchParams(query);
    this.draft = this.desired.get("q") ?? "";
    if (history) this.issued.clear();
    this.listeners.forEach((listener) => listener());
  }
  /** Also release a deferred view when navigation fails or is cancelled. */
  finish(query: string) {
    if (!this.submitted) return;
    this.submitted = undefined;
    this.reconcileView(query);
  }
  private reconcileView(query: string) {
    const committedView = new URLSearchParams(query).get("view") === "grid" ? "grid" : "list";
    if (committedView !== this.viewSnapshot()) this.applyView(this.viewSnapshot());
  }
  private applyView(value: string) {
    const query = this.view(value);
    if (query !== undefined) this.remember(query);
  }
  change(key: string, value: string | number, delay = 0) {
    this.desired.set(key, String(value));
    if (key === "q") {
      this.draft = String(value);
      this.listeners.forEach((listener) => listener());
    }
    if (key !== "page" && key !== "view") this.desired.delete("page");
    if (key === "view") {
      // Update presentation immediately, without cancelling or submitting the search timer.
      this.listeners.forEach((listener) => listener());
      // Updating native history during an RSC navigation can cancel its pending search.
      if (!this.submitted) this.applyView(String(value));
      return;
    }
    this.dispose();
    const run = () => {
      const query = this.desired.toString();
      this.submitted = query;
      this.remember(query);
      this.navigate(query);
    };
    if (delay) this.timer = setTimeout(run, delay);
    else run();
  }
}
