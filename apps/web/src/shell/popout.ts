import { createContext, useContext } from "react";

/** True inside a popped-out window (`?popout=1`): the page there has no chrome to pop out of. */
export const PopoutContext = createContext(false);

export const useIsPopout = (): boolean => useContext(PopoutContext);
