import "./styles.css";
import { DaybookApp } from "./app";
import { browserRepository } from "./storage";
import { AccountController } from "./account";
import { supabase } from "./supabase";
import { CloudStateRepository, createSupabaseDaybookCloud } from "./cloud-sync";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Missing #app root");

const repository = supabase ? new CloudStateRepository(createSupabaseDaybookCloud(supabase), browserRepository) : browserRepository;
new DaybookApp(root, repository, new AccountController(supabase?.auth ?? null)).start();
