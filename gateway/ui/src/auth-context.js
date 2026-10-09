// Shared login state: who is logged in, and functions to log in and out.

import { createContext, useContext } from "react";

export const AuthContext = createContext(null);

export function useAuth() {
  return useContext(AuthContext);
}