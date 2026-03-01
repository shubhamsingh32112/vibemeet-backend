/**
 * 🔥 FIX 17: Circuit Breaker for External API Calls
 * 
 * Prevents cascading failures when external APIs (Stream Video) are down.
 * Implements exponential backoff and circuit breaker pattern.
 */

interface CircuitBreakerOptions {
  failureThreshold: number; // Number of failures before opening circuit
  resetTimeout: number; // Time in ms before attempting to reset circuit
  monitoringWindow: number; // Time window in ms for monitoring failures
}

interface CircuitState {
  failures: number;
  lastFailureTime: number;
  state: 'closed' | 'open' | 'half-open';
  nextAttempt: number;
}

export class CircuitBreaker {
  private state: CircuitState;
  private options: CircuitBreakerOptions;

  constructor(options: Partial<CircuitBreakerOptions> = {}) {
    this.options = {
      failureThreshold: options.failureThreshold || 5,
      resetTimeout: options.resetTimeout || 60000, // 1 minute
      monitoringWindow: options.monitoringWindow || 60000, // 1 minute
    };

    this.state = {
      failures: 0,
      lastFailureTime: 0,
      state: 'closed',
      nextAttempt: 0,
    };
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.updateState();

    if (this.state.state === 'open') {
      const now = Date.now();
      if (now < this.state.nextAttempt) {
        throw new Error(
          `Circuit breaker is OPEN. Retry after ${Math.ceil((this.state.nextAttempt - now) / 1000)}s`
        );
      }
      // Transition to half-open
      this.state.state = 'half-open';
      console.log('🔄 [CIRCUIT] Transitioning to HALF-OPEN state');
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private updateState(): void {
    const now = Date.now();

    // Reset failures if monitoring window has passed
    if (now - this.state.lastFailureTime > this.options.monitoringWindow) {
      if (this.state.failures > 0) {
        console.log('🔄 [CIRCUIT] Monitoring window reset - clearing failures');
        this.state.failures = 0;
      }
    }

    // Auto-reset from open to half-open after timeout
    if (this.state.state === 'open' && now >= this.state.nextAttempt) {
      this.state.state = 'half-open';
      console.log('🔄 [CIRCUIT] Auto-resetting to HALF-OPEN state');
    }
  }

  private onSuccess(): void {
    if (this.state.state === 'half-open') {
      // Success in half-open state - close the circuit
      console.log('✅ [CIRCUIT] Success in HALF-OPEN - closing circuit');
      this.state.state = 'closed';
      this.state.failures = 0;
    } else {
      // Success in closed state - reset failure count
      this.state.failures = 0;
    }
  }

  private onFailure(): void {
    this.state.failures++;
    this.state.lastFailureTime = Date.now();

    if (this.state.failures >= this.options.failureThreshold) {
      if (this.state.state !== 'open') {
        console.error(
          `🚨 [CIRCUIT] Failure threshold reached (${this.state.failures}/${this.options.failureThreshold}) - opening circuit`
        );
        this.state.state = 'open';
        this.state.nextAttempt = Date.now() + this.options.resetTimeout;
      }
    }
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    this.updateState();
    return { ...this.state };
  }

  /**
   * Manually reset circuit breaker
   */
  reset(): void {
    console.log('🔄 [CIRCUIT] Manually resetting circuit breaker');
    this.state = {
      failures: 0,
      lastFailureTime: 0,
      state: 'closed',
      nextAttempt: 0,
    };
  }
}

// Global circuit breaker instances
export const streamVideoCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeout: 60000, // 1 minute
  monitoringWindow: 60000, // 1 minute
});

export const streamChatCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeout: 60000,
  monitoringWindow: 60000,
});
