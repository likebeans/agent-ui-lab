import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';

type RecoveryProps = {
  name: string;
  returnTo?: string;
  returnLabel?: string;
  active: boolean;
  retryDisabled?: boolean;
  onRetry: () => void;
};

class ModuleLoadError extends Error {}

type FailedStylesheets = Map<string, HTMLLinkElement>;

function retryStylesheets(failed: FailedStylesheets) {
  return Promise.all(
    [...failed].map(
      ([href, previous]) =>
        new Promise<void>((resolve, reject) => {
          const link = previous.cloneNode() as HTMLLinkElement;
          failed.set(href, link);
          const cleanup = () => {
            link.onload = null;
            link.onerror = null;
          };
          link.onload = () => {
            cleanup();
            failed.delete(href);
            resolve();
          };
          link.onerror = () => {
            cleanup();
            reject(new Error(`Unable to preload CSS for ${href}`));
          };
          if (previous.isConnected) previous.replaceWith(link);
          else document.head.appendChild(link);
        }),
    ),
  );
}

function loadModule<Props extends object>(
  load: () => Promise<{ default: ComponentType<Props> }>,
  failedStylesheets: FailedStylesheets,
) {
  return lazy(async () => {
    // Vite caches failed CSS preloads too. Retry their links before invoking its loader again.
    const rememberStylesheetFailure = (event: Event) => {
      const link = event.target;
      if (link instanceof HTMLLinkElement && link.rel === 'stylesheet')
        failedStylesheets.set(link.href, link);
    };
    document.addEventListener('error', rememberStylesheetFailure, true);
    try {
      await retryStylesheets(failedStylesheets);
      return await load();
    } catch (cause) {
      throw new ModuleLoadError('模块加载失败。', { cause });
    } finally {
      document.removeEventListener('error', rememberStylesheetFailure, true);
    }
  });
}

function ModuleFailure({
  name,
  returnTo,
  returnLabel,
  active,
  retryDisabled,
  onRetry,
}: RecoveryProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (active) heading.current?.focus({ preventScroll: true });
  }, [active]);
  return (
    <section className="module-recovery" aria-label={`${name}暂时无法打开`}>
      <h2 ref={heading} tabIndex={-1}>
        {name}暂时无法打开
      </h2>
      <p role="alert">加载时遇到问题，请检查网络连接后重试。其他回复、表单和工作区内容仍会保留。</p>
      <div className="module-recovery-actions">
        <button className="button primary" type="button" disabled={retryDisabled} onClick={onRetry}>
          重试加载
        </button>
        {returnTo && returnLabel && (
          <a className="button secondary" href={returnTo}>
            {returnLabel}
          </a>
        )}
      </div>
    </section>
  );
}

class ModuleBoundary extends Component<
  RecoveryProps & {
    children: ReactNode;
    loadErrorsOnly: boolean;
    onFailure?: () => void;
  },
  { error: { cause: unknown } | null }
> {
  state: { error: { cause: unknown } | null } = { error: null };
  static getDerivedStateFromError(cause: unknown) {
    return { error: { cause } };
  }
  componentDidCatch() {
    this.props.onFailure?.();
  }
  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.loadErrorsOnly && !(this.state.error.cause instanceof ModuleLoadError))
      throw this.state.error.cause;
    return <ModuleFailure {...this.props} />;
  }
}

export function RecoverableModule<Props extends object>({
  load,
  componentProps,
  name,
  returnTo,
  returnLabel,
  active = true,
  retryDisabled = false,
  loadErrorsOnly = false,
  onFailure,
  onRetry,
}: {
  load: () => Promise<{ default: ComponentType<Props> }>;
  componentProps: Props;
  name: string;
  returnTo?: string;
  returnLabel?: string;
  active?: boolean;
  retryDisabled?: boolean;
  // Mounted chat replies may already have effects; only failed imports can be retried safely.
  loadErrorsOnly?: boolean;
  onFailure?: () => void;
  onRetry?: () => void;
}) {
  const failedStylesheets = useRef<FailedStylesheets>(new Map());
  const [attempt, setAttempt] = useState(() => ({
    Component: loadModule(load, failedStylesheets.current),
    number: 0,
  }));
  const Loaded = attempt.Component;
  return (
    <ModuleBoundary
      key={attempt.number}
      name={name}
      returnTo={returnTo}
      returnLabel={returnLabel}
      active={active}
      retryDisabled={retryDisabled}
      loadErrorsOnly={loadErrorsOnly}
      onFailure={onFailure}
      onRetry={() => {
        if (retryDisabled) return;
        onRetry?.();
        setAttempt((previous) => ({
          Component: loadModule(load, failedStylesheets.current),
          number: previous.number + 1,
        }));
      }}
    >
      <Suspense
        fallback={
          <p className="module-loading" role="status">
            正在打开{name}…
          </p>
        }
      >
        <Loaded {...componentProps} />
      </Suspense>
    </ModuleBoundary>
  );
}
