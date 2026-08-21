/**
 * Two-phase Quick Create orchestration state machine.
 *
 * The Quick Create install is NOT a one-shot create — it is a two-phase flow
 * separated by the relay's FIRST contact (which proves the customer's bootstrap
 * stack reached CREATE_COMPLETE, because only a deployed relay Lambda can poll):
 *
 *   PHASE 1 (bootstrap)              PHASE 2 (application)
 *   ──────────────────               ──────────────────────
 *   UNPUBLISHED                      REGISTERING_INSTALL   ← relay first contact
 *     └─ bootstrap.published           └─ preflight.passed
 *        BOOTSTRAP_PUBLISHED              PREFLIGHTING
 *          └─ customer.create_started       └─ relay.callback
 *             CUSTOMER_CREATING               CREATING_APPLICATION
 *               └─ relay.first_contact          └─ application.create_complete
 *                                                 APPLICATION_CREATED ✓
 *
 * The relay's first contact is the phase boundary: it registers the
 * installation by binding the minted install ID to the bootstrap-generated
 * credential (the credential token binding itself is a control-plane DB
 * concern — todos 12/13 — the state machine only records the install ID).
 *
 * Pure state machine: transitions are validated against a fixed table, the
 * context records the install ID + template/Quick-Create URLs, and every
 * accepted transition is appended to an immutable history (the seed of §62
 * auditability). No AWS, no I/O — fully unit-testable with mock events.
 */

export type InstallState =
  | 'UNPUBLISHED'
  | 'BOOTSTRAP_PUBLISHED'
  | 'CUSTOMER_CREATING'
  | 'REGISTERING_INSTALL'
  | 'PREFLIGHTING'
  | 'CREATING_APPLICATION'
  | 'APPLICATION_CREATED'
  | 'FAILED';

export type InstallPhase = 'PHASE_1_BOOTSTRAP' | 'PHASE_2_APPLICATION';

export type InstallEvent =
  | {
      readonly type: 'bootstrap.published';
      readonly templateUrl: string;
      readonly quickCreateUrl: string;
    }
  | { readonly type: 'customer.create_started' }
  | { readonly type: 'relay.first_contact'; readonly installationId: string }
  | { readonly type: 'preflight.passed' }
  | { readonly type: 'relay.callback' }
  | { readonly type: 'application.create_complete' }
  | { readonly type: 'failed'; readonly reason: string };

export type InstallEventType = InstallEvent['type'];

/**
 * Classifies a state into its phase. FAILED is terminal and phase-agnostic —
 * the orchestrator resolves its phase from where the failure occurred.
 */
export function phaseOf(state: InstallState): InstallPhase {
  return state === 'UNPUBLISHED' ||
    state === 'BOOTSTRAP_PUBLISHED' ||
    state === 'CUSTOMER_CREATING' ||
    state === 'FAILED'
    ? 'PHASE_1_BOOTSTRAP'
    : 'PHASE_2_APPLICATION';
}

/**
 * The transition table: `state → (event type → next state)`. An event not
 * listed for the current state is rejected.
 */
export const TRANSITIONS: Record<
  InstallState,
  Partial<Record<InstallEventType, InstallState>>
> = {
  UNPUBLISHED: {
    'bootstrap.published': 'BOOTSTRAP_PUBLISHED',
  },
  BOOTSTRAP_PUBLISHED: {
    'customer.create_started': 'CUSTOMER_CREATING',
    // A customer may complete the bootstrap without us observing a link click;
    // the first relay poll is the authoritative signal either way.
    'relay.first_contact': 'REGISTERING_INSTALL',
    failed: 'FAILED',
  },
  CUSTOMER_CREATING: {
    'relay.first_contact': 'REGISTERING_INSTALL',
    failed: 'FAILED',
  },
  REGISTERING_INSTALL: {
    'preflight.passed': 'PREFLIGHTING',
    failed: 'FAILED',
  },
  PREFLIGHTING: {
    'relay.callback': 'CREATING_APPLICATION',
    failed: 'FAILED',
  },
  CREATING_APPLICATION: {
    'application.create_complete': 'APPLICATION_CREATED',
    failed: 'FAILED',
  },
  APPLICATION_CREATED: {},
  FAILED: {},
};

export interface TransitionResult {
  readonly accepted: boolean;
  readonly from: InstallState;
  readonly to: InstallState;
  readonly phase: InstallPhase;
  /** Present only when `accepted` is false. */
  readonly reason?: string;
}

export interface TransitionRecord {
  readonly event: InstallEvent;
  readonly from: InstallState;
  readonly to: InstallState;
  /** ISO-8601 timestamp of the transition. */
  readonly at: string;
}

interface InstallContext {
  templateUrl?: string;
  quickCreateUrl?: string;
  installationId?: string;
  failureReason?: string;
}

export class QuickCreateOrchestrator {
  private _state: InstallState = 'UNPUBLISHED';
  private _failedFrom?: InstallState;
  private _context: InstallContext = {};
  private _history: TransitionRecord[] = [];

  get state(): InstallState {
    return this._state;
  }

  /** The phase of the current state (FAILED resolves via `failedFrom`). */
  get phase(): InstallPhase {
    if (this._state === 'FAILED' && this._failedFrom) {
      return phaseOf(this._failedFrom);
    }
    return phaseOf(this._state);
  }

  get isComplete(): boolean {
    return this._state === 'APPLICATION_CREATED';
  }

  get isFailed(): boolean {
    return this._state === 'FAILED';
  }

  get templateUrl(): string | undefined {
    return this._context.templateUrl;
  }

  get quickCreateUrl(): string | undefined {
    return this._context.quickCreateUrl;
  }

  /** Install ID bound at the relay's first contact. */
  get installationId(): string | undefined {
    return this._context.installationId;
  }

  get failureReason(): string | undefined {
    return this._context.failureReason;
  }

  /** Immutable record of every accepted transition. */
  get history(): readonly TransitionRecord[] {
    return this._history;
  }

  /**
   * Applies an event if it is legal from the current state. Returns a result
   * object; illegal transitions are rejected WITHOUT mutating state.
   */
  transition(event: InstallEvent): TransitionResult {
    const from = this._state;
    const to = TRANSITIONS[from]?.[event.type];

    if (!to) {
      return {
        accepted: false,
        from,
        to: from,
        phase: this.phase,
        reason: `event "${event.type}" is not allowed from state "${from}"`,
      };
    }

    this.applyEvent(event);
    this._state = to;
    this._history.push({
      event,
      from,
      to,
      at: new Date().toISOString(),
    });

    return { accepted: true, from, to, phase: this.phase };
  }

  private applyEvent(event: InstallEvent): void {
    switch (event.type) {
      case 'bootstrap.published':
        this._context.templateUrl = event.templateUrl;
        this._context.quickCreateUrl = event.quickCreateUrl;
        break;
      case 'relay.first_contact':
        this._context.installationId = event.installationId;
        break;
      case 'failed':
        this._failedFrom = this._state;
        this._context.failureReason = event.reason;
        break;
      default:
        break;
    }
  }
}
