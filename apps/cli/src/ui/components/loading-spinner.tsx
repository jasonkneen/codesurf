import { useEffect, useState } from "react";

const LOADING_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function LoadingSpinner() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setFrame((n) => (n + 1) % LOADING_SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);

  return <>{LOADING_SPINNER_FRAMES[frame]}</>;
}
