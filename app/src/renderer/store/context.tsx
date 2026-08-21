import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { AgentStore, type AgentSnapshot } from "./agent-store.ts";

const StoreContext = createContext<AgentStore | undefined>(undefined);

export function AgentProvider({ children }: { children: ReactNode }): ReactNode {
  const store = useMemo(() => new AgentStore(), []);
  useEffect(() => {
    void store.restoreSessions();
  }, [store]);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): AgentStore {
  const store = useContext(StoreContext);
  if (store === undefined) throw new Error("AgentProvider is missing.");
  return store;
}

export function useAgent(): AgentSnapshot {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

export function useIsSending(): boolean {
  const state = useAgent();
  return (
    state.currentSessionId !== undefined &&
    state.activeSessionIds.includes(state.currentSessionId)
  );
}
