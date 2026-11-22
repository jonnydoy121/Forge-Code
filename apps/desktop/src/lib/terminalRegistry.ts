/** Lets the agent panel read the integrated terminal's recent output (the @terminal attachment). */
export const terminalRegistry: { read: () => string } = { read: () => "" };
