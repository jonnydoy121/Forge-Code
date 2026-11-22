import { Suspense, lazy, type ComponentProps, type ComponentType } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;

/**
 * A component whose code is downloaded the first time it is rendered, not at startup. Call sites keep using it like any
 * other component; while it loads (a few milliseconds from local disk) it renders nothing.
 *   const Terminal = lazyView(() => import("./components/Terminal"), "Terminal");
 */
export function lazyView<M extends Record<string, AnyComponent>, K extends keyof M & string>(load: () => Promise<M>, name: K): ComponentType<ComponentProps<M[K]>> {
  const Inner = lazy(() => load().then((m) => ({ default: m[name] as AnyComponent })));
  const Wrapped = (props: ComponentProps<M[K]>) => (
    <Suspense fallback={null}>
      <Inner {...props} />
    </Suspense>
  );
  return Wrapped;
}
