import { runPageDomOp } from "./domOps.js";
class PlaywrightWorkerCompat {
  constructor(worker) {
    this.worker = worker;
  }
  worker;
  async evaluate(script) {
    return await this.worker.evaluate(script);
  }
}
class PlaywrightLocatorCompat {
  constructor(locator) {
    this.locator = locator;
  }
  locator;
  wrap(next) {
    return new PlaywrightLocatorCompat(next);
  }
  count() {
    return this.locator.count();
  }
  nth(index) {
    return this.wrap(this.locator.nth(index));
  }
  first() {
    return this.wrap(this.locator.first());
  }
  last() {
    return this.wrap(this.locator.last());
  }
  filter(options) {
    return this.wrap(this.locator.filter({ hasText: options.hasText }));
  }
  getByText(text) {
    return this.wrap(this.locator.getByText(text));
  }
  isVisible(options) {
    return this.locator.isVisible(options);
  }
  isEnabled() {
    return this.locator.isEnabled();
  }
  focus() {
    return this.locator.focus();
  }
  boundingBox() {
    return this.locator.boundingBox();
  }
  scrollIntoViewIfNeeded() {
    return this.locator.scrollIntoViewIfNeeded();
  }
  click(options) {
    return this.locator.click(options);
  }
  press(key, options) {
    return this.locator.press(key, options);
  }
  waitFor(options) {
    return this.locator.waitFor({
      timeout: options?.timeout,
      state: options?.state
    });
  }
  async readInputValue() {
    return await this.locator.evaluate((element) => {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        return element.value;
      }
      if (element instanceof HTMLElement) {
        return element.innerText || element.textContent || "";
      }
      return "";
    });
  }
  async setInputValue(value) {
    await this.locator.evaluate((element, nextValue) => {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        const proto = Object.getPrototypeOf(element);
        const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
        if (descriptor?.set) {
          descriptor.set.call(element, nextValue);
        } else {
          element.value = nextValue;
        }
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }
      if (element instanceof HTMLElement) {
        element.focus();
        element.innerText = nextValue;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, value);
  }
  async getEditableState() {
    return await this.locator.evaluate((element) => {
      function hasHiddenAncestor(target) {
        let current = target;
        while (current) {
          if (current.hidden || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert")) {
            return true;
          }
          const style = window.getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0" || style.pointerEvents === "none") {
            return true;
          }
          current = current.parentElement;
        }
        return false;
      }
      function acceptsTextInput(target) {
        if (target instanceof HTMLTextAreaElement) {
          return true;
        }
        if (target instanceof HTMLInputElement) {
          const blockedTypes = /* @__PURE__ */ new Set([
            "hidden",
            "button",
            "checkbox",
            "color",
            "file",
            "image",
            "radio",
            "range",
            "reset",
            "submit"
          ]);
          return !blockedTypes.has(target.type);
        }
        return target.isContentEditable || target.getAttribute("contenteditable") === "true";
      }
      function isEnabled(target) {
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
          return !target.disabled && !target.readOnly;
        }
        return target.getAttribute("aria-disabled") !== "true" && !target.hasAttribute("disabled") && target.getAttribute("contenteditable") !== "false";
      }
      if (!(element instanceof HTMLElement)) {
        return {
          connected: false,
          visible: false,
          editable: false,
          enabled: false,
          acceptsTextInput: false
        };
      }
      const rect = element.getBoundingClientRect();
      const clientRects = element.getClientRects();
      const visibleByBrowser = typeof element.checkVisibility === "function" ? element.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true
      }) : true;
      const visible = element.isConnected && visibleByBrowser && !hasHiddenAncestor(element) && clientRects.length > 0 && rect.width > 0 && rect.height > 0;
      const enabled = isEnabled(element);
      const textInput = acceptsTextInput(element);
      return {
        connected: element.isConnected,
        visible,
        editable: visible && enabled && textInput,
        enabled,
        acceptsTextInput: textInput
      };
    });
  }
  async dispatchClick() {
    await this.locator.evaluate((element) => {
      if (!(element instanceof HTMLElement)) return;
      element.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window
        })
      );
    });
  }
}
class PlaywrightBrowserContextCompat {
  constructor(context) {
    this.context = context;
    const existingPages = this.context.pages();
    this.initialPage = existingPages.length === 1 && existingPages[0]?.url() === "about:blank" ? existingPages[0] : null;
  }
  context;
  pageMap = /* @__PURE__ */ new WeakMap();
  initialPage;
  wrapPage(page) {
    const existing = this.pageMap.get(page);
    if (existing) return existing;
    const wrapped = new PlaywrightPageCompat(page, this);
    this.pageMap.set(page, wrapped);
    return wrapped;
  }
  getRawContext() {
    return this.context;
  }
  getBrowser() {
    const browser = this.context.browser();
    if (browser) return browser;
    return {
      version: () => "Camoufox",
      close: () => this.context.close()
    };
  }
  async newPage() {
    if (this.initialPage) {
      const page = this.initialPage;
      this.initialPage = null;
      return this.wrapPage(page);
    }
    return this.wrapPage(await this.context.newPage());
  }
  async close() {
    await this.context.close();
  }
  async storageState(options) {
    await this.context.storageState(options);
  }
  async addInitScript(script) {
    await this.context.addInitScript(script);
  }
  on(event, listener) {
    this.context.on(event, (page) => {
      listener(this.wrapPage(page));
    });
  }
}
class PlaywrightPageCompat {
  constructor(page, owner) {
    this.page = page;
    this.owner = owner;
    this.mouse = this.page.mouse;
    this.keyboard = this.page.keyboard;
  }
  page;
  owner;
  mouse;
  keyboard;
  getRawPage() {
    return this.page;
  }
  async goto(url, options) {
    await this.page.goto(url, options);
  }
  async evaluate(pageFunction, arg) {
    return await this.page.evaluate(pageFunction, arg);
  }
  url() {
    return this.page.url();
  }
  async getUrl() {
    return this.page.url();
  }
  waitForTimeout(ms) {
    return this.page.waitForTimeout(ms);
  }
  waitForLoadState(state, options) {
    return this.page.waitForLoadState(state, options);
  }
  async waitForSelector(selector, options) {
    await this.page.waitForSelector(selector, options ?? {});
  }
  locator(selector) {
    return new PlaywrightLocatorCompat(this.page.locator(selector));
  }
  close() {
    return this.page.close();
  }
  setDefaultTimeout(ms) {
    this.page.setDefaultTimeout(ms);
  }
  setDefaultNavigationTimeout(ms) {
    this.page.setDefaultNavigationTimeout(ms);
  }
  on(event, listener) {
    if (event === "console") {
      this.page.on(event, listener);
      return;
    }
    this.page.on(event, (worker) => {
      listener(
        new PlaywrightWorkerCompat(worker)
      );
    });
  }
  context() {
    return this.owner;
  }
  viewportSize() {
    return this.page.viewportSize();
  }
  async runDomOp(operation, params) {
    return await runPageDomOp(
      this.page,
      operation,
      params ?? {}
    );
  }
  async ping() {
    try {
      await Promise.race([
        this.page.evaluate(() => true),
        new Promise(
          (_, reject) => setTimeout(() => reject(new Error("page ping timeout")), 5e3)
        )
      ]);
      return true;
    } catch {
      return false;
    }
  }
  async screenshot(options) {
    return await this.page.screenshot(options ?? {});
  }
}
export {
  PlaywrightBrowserContextCompat
};
