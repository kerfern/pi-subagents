import type { ExtensionContext, ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";

const MAX_CONFIRMATION_MS = 60_000;

type RootContext = Pick<ExtensionContext, "hasUI" | "ui">;
type RootUi = ExtensionUIContext;
type FacadeValue = RootUi[keyof RootUi] | undefined;

export interface ChildConfirmationBinding {
  readonly uiContext?: ExtensionUIContext;
  beginRun(signal?: AbortSignal): () => void;
}

interface BindingState {
  readonly agentId: string;
  readonly agentName: string;
  pinned: boolean;
  pinnedEpoch: number;
  nativeUi?: RootUi;
  facade?: ExtensionUIContext;
  currentLease?: RunLease;
}

interface RunLease {
  readonly binding: BindingState;
  readonly epoch: number;
  readonly signal?: AbortSignal;
  closed: boolean;
  abortListener?: () => void;
}

interface ConfirmationRequest {
  readonly binding: BindingState;
  readonly lease: RunLease;
  readonly epoch: number;
  readonly nativeUi: RootUi;
  readonly title: string;
  readonly message: string;
  readonly deadline: number;
  readonly nativeAbort: AbortController;
  readonly callerSignal?: AbortSignal;
  callerAbortListener?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
  resolve(value: boolean): void;
}

/**
 * One FIFO for child confirmation dialogs. The bridge only lends the root's
 * native UI capability to a particular child session/run; it never interprets
 * the child's own UI context as operator authority.
 */
export class ChildConfirmationBridge {
  private epoch = 0;
  private disposed = false;
  private draining = false;
  private activeRequest?: ConfirmationRequest;
  private readonly queue: ConfirmationRequest[] = [];
  private readonly requests = new Set<ConfirmationRequest>();
  private readonly leases = new Set<RunLease>();

  constructor(private readonly resolveRoot: () => RootContext | undefined) {}

  forChild(agentId: string, agentName: string): ChildConfirmationBinding {
    const state: BindingState = {
      agentId,
      agentName,
      pinned: false,
      pinnedEpoch: -1,
    };

    const binding: ChildConfirmationBinding = {
      get uiContext() {
        return thisBridge.getFacade(state);
      },
      beginRun: (signal) => this.beginRun(state, signal),
    };
    const thisBridge = this;
    return binding;
  }

  /** Invalidate all currently issued capabilities before switching roots. */
  invalidate(): void {
    if (this.disposed) return;
    this.epoch++;
    for (const lease of [...this.leases]) this.closeLease(lease);
  }

  /** Permanently revoke capabilities and deny every unsettled request. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    for (const lease of [...this.leases]) this.closeLease(lease);
    for (const request of [...this.requests]) this.settle(request, false);
  }

  private currentRoot(): RootContext | undefined {
    if (this.disposed) return undefined;
    try {
      const root = this.resolveRoot();
      return root?.hasUI ? root : undefined;
    } catch {
      return undefined;
    }
  }

  private getFacade(binding: BindingState): ExtensionUIContext | undefined {
    if (binding.pinned) return binding.facade;
    binding.pinned = true;

    const root = this.currentRoot();
    if (!root) return undefined;

    binding.nativeUi = root.ui;
    binding.pinnedEpoch = this.epoch;
    const nativeUi = root.ui;
    const confirm: RootUi["confirm"] = (title, message, options) =>
      this.requestConfirmation(binding, nativeUi, title, message, options);
    const isInheritedObjectMethod = (property: PropertyKey) =>
      Object.hasOwn(Object.prototype, property) && !Object.hasOwn(nativeUi, property);
    const getValue = (property: PropertyKey): FacadeValue => {
      if (property === "confirm") return confirm;
      if (isInheritedObjectMethod(property)) return undefined;
      const value = nativeUi[property as keyof RootUi];
      return typeof value === "function" ? value.bind(nativeUi) : value;
    };

    binding.facade = new Proxy(Object.create(null) as ExtensionUIContext, {
      get(_target, property) {
        return getValue(property);
      },
      set() {
        return false;
      },
      has(_target, property) {
        return !isInheritedObjectMethod(property) && Reflect.has(nativeUi, property);
      },
      ownKeys() {
        return Reflect.ownKeys(nativeUi);
      },
      getOwnPropertyDescriptor(_target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(nativeUi, property);
        if (!descriptor && property !== "confirm") return undefined;
        return {
          configurable: true,
          enumerable: descriptor?.enumerable ?? true,
          writable: false,
          value: getValue(property),
        };
      },
    });
    return binding.facade;
  }

  private beginRun(binding: BindingState, signal?: AbortSignal): () => void {
    if (binding.currentLease) this.closeLease(binding.currentLease);

    const lease: RunLease = {
      binding,
      epoch: this.epoch,
      signal,
      closed: false,
    };
    binding.currentLease = lease;
    this.leases.add(lease);

    if (signal) {
      if (signal.aborted) {
        this.closeLease(lease);
      } else {
        lease.abortListener = () => this.closeLease(lease);
        signal.addEventListener("abort", lease.abortListener, { once: true });
      }
    }
    if (this.disposed) this.closeLease(lease);

    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.closeLease(lease);
    };
  }

  private closeLease(lease: RunLease): void {
    if (lease.closed) return;
    lease.closed = true;
    if (lease.signal && lease.abortListener) {
      lease.signal.removeEventListener("abort", lease.abortListener);
    }
    this.leases.delete(lease);
    if (lease.binding.currentLease === lease) lease.binding.currentLease = undefined;
    for (const request of [...this.requests]) {
      if (request.lease === lease) this.settle(request, false);
    }
  }

  private isLeaseLive(binding: BindingState, lease: RunLease, nativeUi: RootUi): boolean {
    if (
      this.disposed ||
      lease.closed ||
      lease.signal?.aborted ||
      binding.currentLease !== lease ||
      binding.nativeUi !== nativeUi ||
      binding.pinnedEpoch !== lease.epoch ||
      this.epoch !== lease.epoch
    ) {
      return false;
    }
    const root = this.currentRoot();
    return root !== undefined && root.ui === nativeUi;
  }

  private requestConfirmation(
    binding: BindingState,
    nativeUi: RootUi,
    title: string,
    message: string,
    options?: ExtensionUIDialogOptions,
  ): Promise<boolean> {
    const lease = binding.currentLease;
    if (!lease || !this.isLeaseLive(binding, lease, nativeUi)) return Promise.resolve(false);

    const timeout = this.timeoutFor(options?.timeout);
    if (timeout === null || options?.signal?.aborted) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      const request: ConfirmationRequest = {
        binding,
        lease,
        epoch: this.epoch,
        nativeUi,
        title,
        message,
        deadline: performance.now() + timeout,
        nativeAbort: new AbortController(),
        callerSignal: options?.signal,
        settled: false,
        resolve,
      };

      if (request.callerSignal) {
        request.callerAbortListener = () => this.settle(request, false);
        request.callerSignal.addEventListener("abort", request.callerAbortListener, { once: true });
      }
      request.timer = setTimeout(() => this.settle(request, false), timeout);
      this.requests.add(request);
      this.queue.push(request);
      this.drainQueue();
    });
  }

  private timeoutFor(timeout: number | undefined): number | null {
    if (timeout === undefined || timeout === Number.POSITIVE_INFINITY) return MAX_CONFIRMATION_MS;
    if (!Number.isFinite(timeout) || timeout <= 0) return null;
    return Math.min(timeout, MAX_CONFIRMATION_MS);
  }

  private requestIsLive(request: ConfirmationRequest): boolean {
    return (
      !request.settled &&
      performance.now() < request.deadline &&
      request.epoch === this.epoch &&
      request.binding.currentLease === request.lease &&
      this.isLeaseLive(request.binding, request.lease, request.nativeUi)
    );
  }

  private settle(request: ConfirmationRequest, approved: boolean): void {
    if (request.settled) return;
    const mayApprove = approved && this.requestIsLive(request);
    request.settled = true;
    if (request.timer !== undefined) clearTimeout(request.timer);
    if (request.callerSignal && request.callerAbortListener) {
      request.callerSignal.removeEventListener("abort", request.callerAbortListener);
    }
    this.requests.delete(request);
    const queuedIndex = this.queue.indexOf(request);
    if (queuedIndex !== -1) this.queue.splice(queuedIndex, 1);
    if (!mayApprove && this.activeRequest === request) request.nativeAbort.abort();
    request.resolve(mayApprove);
  }

  private drainQueue(): void {
    if (this.draining || this.disposed) return;
    this.draining = true;
    void (async () => {
      try {
        while (this.queue.length > 0) {
          const request = this.queue.shift()!;
          if (request.settled) continue;
          if (!this.requestIsLive(request)) {
            this.settle(request, false);
            continue;
          }

          this.activeRequest = request;
          try {
            const remaining = Math.max(0, request.deadline - performance.now());
            const nativeConfirm = request.nativeUi.confirm;
            const result = await nativeConfirm.call(
              request.nativeUi,
              `[Child name=${request.binding.agentName}; id=${request.binding.agentId}] ${request.title}`,
              request.message,
              { signal: request.nativeAbort.signal, timeout: remaining },
            );
            this.settle(request, result === true);
          } catch {
            this.settle(request, false);
          } finally {
            if (!request.settled) this.settle(request, false);
            if (this.activeRequest === request) this.activeRequest = undefined;
          }
        }
      } finally {
        this.draining = false;
        if (this.queue.length > 0 && !this.disposed) this.drainQueue();
      }
    })();
  }
}
