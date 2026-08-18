import "./styles.css";
import { DaybookApp } from "./app";
import { browserRepository } from "./storage";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Missing #app root");

new DaybookApp(root, browserRepository).start();
