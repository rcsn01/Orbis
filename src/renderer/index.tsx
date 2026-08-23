import "@moirasia/ui-react/styles.css"
import "@moirasia/desktop-shell/styles.css"
import "./styles.css"
import { createRoot } from "react-dom/client"
import { App } from "./App"

createRoot(document.getElementById("root")!).render(<App />)
