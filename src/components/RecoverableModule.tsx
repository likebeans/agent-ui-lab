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
  returnTo: string;
  returnLabel: string;
  active: boolean;
  onRetry: () => void;
};

function ModuleFailure({ name, returnTo, returnLabel, active, onRetry }: RecoveryProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (active) heading.current?.focus({ preventScroll: true });
  }, [active]);
  return (
    <section className="module-recovery" aria-label={`${name}暂时无法打开`}>
      <h2 ref={heading} tabIndex={-1}>
        {name}暂时无法打开
      </h2>
      <p role="alert">加载时遇到问题，请检查网络连接后重试。当前其他工作区的内容仍会保留。</p>
      <div className="module-recovery-actions">
        <button className="button primary" type="button" onClick={onRetry}>
          重试加载
        </button>
        <a className="button secondary" href={returnTo}>
          {returnLabel}
        </a>
      </div>
    </section>
  );
}

class ModuleBoundary extends Component<
  RecoveryProps & { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <ModuleFailure {...this.props} /> : this.props.children;
  }
}

export function RecoverableModule<Props extends object>({
  load,
  componentProps,
  name,
  returnTo,
  returnLabel,
  active = true,
}: {
  load: () => Promise<{ default: ComponentType<Props> }>;
  componentProps: Props;
  name: string;
  returnTo: string;
  returnLabel: string;
  active?: boolean;
}) {
  const [attempt, setAttempt] = useState(() => ({ Component: lazy(load), number: 0 }));
  const Loaded = attempt.Component;
  return (
    <ModuleBoundary
      key={attempt.number}
      name={name}
      returnTo={returnTo}
      returnLabel={returnLabel}
      active={active}
      onRetry={() =>
        setAttempt((previous) => ({ Component: lazy(load), number: previous.number + 1 }))
      }
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
