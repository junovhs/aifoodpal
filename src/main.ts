import "./styles.css";
import { DaybookApp } from "./app";
import { browserRepository } from "./storage";
import { AccountController } from "./account";
import { supabase } from "./supabase";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Missing #app root");

new DaybookApp(root, browserRepository, new AccountController(supabase?.auth ?? null)).start();
