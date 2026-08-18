#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Command } from "commander";
import {
  loadConfig,
  saveConfig,
  clearOAuth,
  maskKey,
  configPath,
  DEFAULT_BASE,
  DEFAULT_WORKFLOW_BASE,
  type Pic58Config,
} from "./config.js";
import { pic58Request, resolveCredentials, routeUrl } from "./client.js";
import { workflowRequest } from "./workflow.js";
import { loginWithOAuth, revokeToken } from "./auth.js";
import { printEnvelope, type OutputFormat } from "./output.js";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as { version: string; name: string };

function addGlobalOpts(cmd: Command): Command {
  return cmd
    .option("--api-key <key>", "API Key（或环境变量 58PIC_API_KEY）")
    .option("--base-url <url>", `API 根地址，默认 ${DEFAULT_BASE}`)
    .option(
      "-f, --format <fmt>",
      "输出：json | pretty | table",
      "pretty"
    ) as Command;
}

function fmtOf(s: string): OutputFormat {
  if (s === "json" || s === "pretty" || s === "table") return s;
  return "pretty";
}

async function getCtx(
  opts: { apiKey?: string; baseUrl?: string },
  file: Pic58Config
) {
  return resolveCredentials(opts, file);
}

function addWorkflowOpts(cmd: Command): Command {
  return addGlobalOpts(cmd).option(
    "--workflow-base-url <url>",
    `工作流 API 根地址，默认 ${DEFAULT_WORKFLOW_BASE}`
  );
}

function workflowBaseOf(
  opts: { workflowBaseUrl?: string },
  file: Pic58Config
): string {
  return (
    opts.workflowBaseUrl ??
    process.env["PIC58_WORKFLOW_BASE_URL"] ??
    file.workflowBaseUrl ??
    DEFAULT_WORKFLOW_BASE
  );
}

function parseJSONObject(raw: string, flagName: string): Record<string, unknown> {
  const value = JSON.parse(raw) as unknown;
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${flagName} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function parseWorkflowID(id: string): number {
  if (!/^\d+$/.test(id)) throw new Error("工作流 ID 必须是正整数");
  const workflowID = Number(id);
  if (!Number.isSafeInteger(workflowID) || workflowID <= 0) {
    throw new Error("工作流 ID 必须是正整数");
  }
  return workflowID;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("58pic")
    .description("千图 AI 开放平台 CLI（分层：配置 / 快捷命令 / 通用 api 调用）")
    .version(pkg.version);

  const configCmd = program
    .command("config")
    .description("本地凭证与 Base URL");

  configCmd
    .command("init")
    .description("交互式写入 ~/.config/58pic/config.json（或 XDG_CONFIG_HOME）")
    .option("--api-key <key>", "非交互：直接写入 Key")
    .option("--base-url <url>", `默认 ${DEFAULT_BASE}`)
    .action(async (o: { apiKey?: string; baseUrl?: string }) => {
      let apiKey = o.apiKey;
      let baseUrl = o.baseUrl ?? DEFAULT_BASE;
      if (!apiKey) {
        const rl = createInterface({ input, output });
        const k = await rl.question("API Key: ");
        apiKey = k.trim();
        const b = await rl.question(`Base URL [${DEFAULT_BASE}]: `);
        if (b.trim()) baseUrl = b.trim();
        rl.close();
      }
      if (!apiKey) {
        console.error("未提供 API Key");
        process.exitCode = 1;
        return;
      }
      await saveConfig({ apiKey, baseUrl });
      console.error(`已写入 ${configPath()}`);
    });

  configCmd
    .command("show")
    .description("查看当前配置文件中的 Key（脱敏）与 Base URL")
    .action(async () => {
      const c = await loadConfig();
      console.log(
        JSON.stringify(
          {
            configPath: configPath(),
            apiKey: maskKey(c.apiKey),
            baseUrl: c.baseUrl ?? DEFAULT_BASE,
            workflowBaseUrl: c.workflowBaseUrl ?? DEFAULT_WORKFLOW_BASE,
          },
          null,
          2
        )
      );
    });

  const authCmd = program
    .command("auth")
    .description("认证管理：OAuth 登录 / 退出 / 状态查看");

  authCmd
    .command("login")
    .description("通过浏览器完成 OAuth 2.1 授权登录")
    .option("--base-url <url>", `API 根地址，默认 ${DEFAULT_BASE}`)
    .option("--force", "已登录时强制重新授权", false)
    .action(
      async (opts: { baseUrl?: string; force: boolean }) => {
        const c = await loadConfig();
        const baseUrl =
          opts.baseUrl ?? process.env["58PIC_BASE_URL"] ?? c.baseUrl ?? DEFAULT_BASE;

        // 已有有效 token 时给出提示
        if (!opts.force && c.oauth?.accessToken) {
          const now = Math.floor(Date.now() / 1000);
          const expiresAt = c.oauth.expiresAt ?? Infinity;
          if (expiresAt > now) {
            console.error(
              "已登录（OAuth）。如需重新授权请加 --force 参数。"
            );
            return;
          }
        }

        try {
          const tokens = await loginWithOAuth(baseUrl);
          console.log(
            JSON.stringify(
              {
                ok: true,
                message: "OAuth 登录成功",
                accessToken: maskKey(tokens.accessToken),
                expiresAt: tokens.expiresAt
                  ? new Date(tokens.expiresAt * 1000).toISOString()
                  : "永久",
              },
              null,
              2
            )
          );
        } catch (e) {
          console.error("OAuth 登录失败：", (e as Error).message);
          process.exitCode = 1;
        }
      }
    );

  const workflowCmd = program
    .command("workflow")
    .description("千图工作流：列出、读取、创建、保存与运行工作流");

  const workflowList = workflowCmd
    .command("list")
    .description("列出当前用户可访问的工作流");
  addWorkflowOpts(workflowList);
  workflowList
    .option("--page <n>", "页码", "1")
    .option("--page-size <n>", "每页数量", "20")
    .option("--keyword <text>", "按名称搜索")
    .action(async (opts: { apiKey?: string; baseUrl?: string; workflowBaseUrl?: string; format: string; page: string; pageSize: string; keyword?: string }) => {
      const file = await loadConfig();
      const ctx = await getCtx(opts, file);
      const query = new URLSearchParams({ page: opts.page, page_size: opts.pageSize });
      if (opts.keyword) query.set("keyword", opts.keyword);
      const result = await workflowRequest({ apiKey: ctx.apiKey, workflowBaseUrl: workflowBaseOf(opts, file) }, `?${query.toString()}`, { method: "GET" });
      printEnvelope(fmtOf(opts.format), result.http, result.body, true);
    });

  const workflowGet = workflowCmd
    .command("get")
    .description("读取工作流及其画布定义")
    .argument("<id>", "工作流 ID");
  addWorkflowOpts(workflowGet);
  workflowGet.option("--version <id>", "指定历史画布版本").action(async (id: string, opts: { apiKey?: string; baseUrl?: string; workflowBaseUrl?: string; format: string; version?: string }) => {
    const file = await loadConfig();
    const ctx = await getCtx(opts, file);
    const workflowID = parseWorkflowID(id);
    const suffix = opts.version ? `?version=${encodeURIComponent(opts.version)}` : "";
    const result = await workflowRequest({ apiKey: ctx.apiKey, workflowBaseUrl: workflowBaseOf(opts, file) }, `/${workflowID}${suffix}`, { method: "GET" });
    printEnvelope(fmtOf(opts.format), result.http, result.body, true);
  });

  const workflowCreate = workflowCmd
    .command("create")
    .description("创建工作流；可从画布 JSON 初始化")
    .argument("<name>", "工作流名称");
  addWorkflowOpts(workflowCreate);
  workflowCreate
    .option("-d, --description <text>", "工作流描述", "")
    .option("--canvas-file <path>", "包含 nodes / edges 的 JSON 文件")
    .action(async (name: string, opts: { apiKey?: string; baseUrl?: string; workflowBaseUrl?: string; format: string; description: string; canvasFile?: string }) => {
      const file = await loadConfig();
      const ctx = await getCtx(opts, file);
      const body: Record<string, unknown> = { name, description: opts.description };
      if (opts.canvasFile) {
        Object.assign(body, parseJSONObject(await readFile(opts.canvasFile, "utf8"), "--canvas-file"));
        // 命令行必填名称优先，避免画布文件中的旧名称覆盖新工作流名称。
        body.name = name;
        if (opts.description) body.description = opts.description;
      }
      const result = await workflowRequest({ apiKey: ctx.apiKey, workflowBaseUrl: workflowBaseOf(opts, file) }, "", { method: "POST", jsonBody: body });
      printEnvelope(fmtOf(opts.format), result.http, result.body, true);
    });

  const workflowSave = workflowCmd
    .command("save")
    .description("保存完整画布；文件必须包含当前 nodes，建议同时包含 edges")
    .argument("<id>", "工作流 ID");
  addWorkflowOpts(workflowSave);
  workflowSave.requiredOption("--canvas-file <path>", "完整画布 JSON 文件").action(async (id: string, opts: { apiKey?: string; baseUrl?: string; workflowBaseUrl?: string; format: string; canvasFile: string }) => {
    const file = await loadConfig();
    const ctx = await getCtx(opts, file);
    const workflowID = parseWorkflowID(id);
    const body = parseJSONObject(await readFile(opts.canvasFile, "utf8"), "--canvas-file");
    const result = await workflowRequest({ apiKey: ctx.apiKey, workflowBaseUrl: workflowBaseOf(opts, file) }, `/${workflowID}/canvas`, { method: "POST", jsonBody: body });
    printEnvelope(fmtOf(opts.format), result.http, result.body, true);
  });

  const workflowRun = workflowCmd
    .command("run")
    .description("运行整个工作流或指定节点")
    .argument("<id>", "工作流 ID");
  addWorkflowOpts(workflowRun);
  workflowRun
    .option("--node <id>", "只运行指定节点")
    .option("--input <json>", "运行输入 JSON", "{}")
    .option("--regular-model", "使用常规模型", false)
    .action(async (id: string, opts: { apiKey?: string; baseUrl?: string; workflowBaseUrl?: string; format: string; node?: string; input: string; regularModel: boolean }) => {
      const file = await loadConfig();
      const ctx = await getCtx(opts, file);
      const body: Record<string, unknown> = {
        workflow_id: parseWorkflowID(id),
        input: parseJSONObject(opts.input, "--input"),
        use_regular_model: opts.regularModel,
      };
      if (opts.node) body.target_node_id = opts.node;
      const result = await workflowRequest({ apiKey: ctx.apiKey, workflowBaseUrl: workflowBaseOf(opts, file) }, "/execute", { method: "POST", jsonBody: body });
      printEnvelope(fmtOf(opts.format), result.http, result.body, true);
    });

  authCmd
    .command("logout")
    .description("退出登录，清除本地存储的 OAuth token")
    .option("--base-url <url>", `API 根地址，默认 ${DEFAULT_BASE}`)
    .action(async (opts: { baseUrl?: string }) => {
      const c = await loadConfig();
      const baseUrl =
        opts.baseUrl ?? process.env["58PIC_BASE_URL"] ?? c.baseUrl ?? DEFAULT_BASE;

      if (!c.oauth) {
        console.log("当前未使用 OAuth 登录，无需退出。");
        return;
      }

      // 服务端撤销 token
      if (c.oauth.accessToken) {
        process.stderr.write("正在撤销服务端 token…\n");
        await revokeToken(baseUrl, c.oauth.accessToken);
      }

      await clearOAuth();
      console.log("已退出 OAuth 登录，本地 token 已清除。");
    });

  authCmd
    .command("status")
    .description("查看当前认证状态（OAuth / API Key）")
    .action(async () => {
      const c = await loadConfig();
      const now = Math.floor(Date.now() / 1000);
      const hasOAuth = Boolean(c.oauth?.accessToken);
      const oauthValid =
        hasOAuth && (c.oauth!.expiresAt == null || c.oauth!.expiresAt > now);
      const hasApiKey = Boolean(c.apiKey ?? process.env["58PIC_API_KEY"]);
      const loggedIn = oauthValid || hasApiKey;

      console.log(
        JSON.stringify(
          {
            loggedIn,
            authMethod: oauthValid
              ? "oauth"
              : hasApiKey
              ? "api-key"
              : "none",
            oauth: hasOAuth
              ? {
                  token: maskKey(c.oauth!.accessToken),
                  valid: oauthValid,
                  expiresAt: c.oauth!.expiresAt
                    ? new Date(c.oauth!.expiresAt * 1000).toISOString()
                    : "永久",
                  hasRefreshToken: Boolean(c.oauth!.refreshToken),
                }
              : null,
            apiKey: hasApiKey
              ? maskKey(c.apiKey ?? process.env["58PIC_API_KEY"])
              : null,
            baseUrl:
              c.baseUrl ?? process.env["58PIC_BASE_URL"] ?? DEFAULT_BASE,
            configPath: configPath(),
          },
          null,
          2
        )
      );
    });

  const search = program
    .command("search")
    .description("快捷：POST open-platform/search-images")
    .argument("[keyword]", "关键词（非 AI 搜索时必填）");
  addGlobalOpts(search);
  search
    .option("-p, --page <n>", "页码 1-100", "1")
    .option("--did <n>", "一级分类 did，0 不限", "0")
    .option("--kid <n>", "兼容 kid，默认 0", "0")
    .option("--ai", "AI 向量搜索", false)
    .action(
      async (
        keyword: string | undefined,
        opts: {
          apiKey?: string;
          baseUrl?: string;
          format: string;
          page: string;
          did: string;
          kid: string;
          ai: boolean;
        }
      ) => {
        const file = await loadConfig();
        const ctx = await getCtx(opts, file);
        if (!opts.ai && (!keyword || !keyword.trim())) {
          console.error("非 AI 搜索请提供关键词，或使用 --ai 做向量搜索");
          process.exitCode = 1;
          return;
        }
        const { http, body } = await pic58Request(ctx, "search-images", {
          method: "POST",
          jsonBody: {
            keyword: keyword ?? "",
            page: Number(opts.page) || 1,
            did: Number(opts.did) || 0,
            kid: Number(opts.kid) || 0,
            ai_search: Boolean(opts.ai),
          },
        });
        printEnvelope(fmtOf(opts.format), http, body, true);
      }
    );

  const catalog = program
    .command("catalog")
    .description("快捷：GET/POST open-platform/search-catalog");
  addGlobalOpts(catalog);
  catalog.action(
    async (opts: { apiKey?: string; baseUrl?: string; format: string }) => {
      const file = await loadConfig();
      const ctx = await getCtx(opts, file);
      const { http, body } = await pic58Request(ctx, "search-catalog", {
        method: "GET",
      });
      printEnvelope(fmtOf(opts.format), http, body, true);
    }
  );

  const models = program
    .command("models")
    .description("快捷：open-platform/available-models");
  addGlobalOpts(models);
  models.action(
    async (opts: { apiKey?: string; baseUrl?: string; format: string }) => {
      const file = await loadConfig();
      const ctx = await getCtx(opts, file);
      const { http, body } = await pic58Request(ctx, "available-models", {
        method: "GET",
      });
      printEnvelope(fmtOf(opts.format), http, body, true);
    }
  );

  const credits = program
    .command("credits")
    .description("快捷：查询当前 API Key 的积分余额与最近扣点记录");
  addGlobalOpts(credits);
  credits.action(
    async (opts: { apiKey?: string; baseUrl?: string; format: string }) => {
      const file = await loadConfig();
      const ctx = await getCtx(opts, file);
      const { http, body } = await pic58Request(ctx, "credits", {
        method: "GET",
      });
      printEnvelope(fmtOf(opts.format), http, body, true);
    }
  );

  const modelCap = program
    .command("model-capabilities")
    .description(
      "快捷：查询指定模型支持的比例（aspect）/ 清晰度（resolution）/ 时长（duration）选项"
    )
    .argument("<model_id>", "模型 ID（可先用 58pic models 查询）");
  addGlobalOpts(modelCap);
  modelCap.action(
    async (
      modelId: string,
      opts: { apiKey?: string; baseUrl?: string; format: string }
    ) => {
      const file = await loadConfig();
      const ctx = await getCtx(opts, file);
      const { http, body } = await pic58Request(ctx, "model-capabilities", {
        method: "POST",
        jsonBody: {
          model_id: /^\d+$/.test(modelId) ? Number(modelId) : modelId,
        },
      });
      printEnvelope(fmtOf(opts.format), http, body, true);
    }
  );

  const download = program
    .command("download")
    .description("快捷：按 pid 获取预览与下载临时链（扣点）")
    .argument("<pid>", "素材 pid");
  addGlobalOpts(download);
  download.action(
    async (
      pid: string,
      opts: { apiKey?: string; baseUrl?: string; format: string }
    ) => {
      const file = await loadConfig();
      const ctx = await getCtx(opts, file);
      const url = `${routeUrl(ctx.baseUrl, "image-download")}&pid=${encodeURIComponent(pid)}`;
      const headers = new Headers();
      headers.set("Authorization", `Bearer ${ctx.apiKey}`);
      const res = await fetch(url, { headers });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
      printEnvelope(fmtOf(opts.format), res.status, parsed, true);
    }
  );

  const sameStyle = program
    .command("same-style")
    .description(
      "快捷：提交生图任务（同一接口支持文生图与垫图做同款；仅需 -m；垫图 / pid 可选，复杂参数见 --body-file）"
    );
  addGlobalOpts(sameStyle);
  sameStyle
    .requiredOption("-m, --model <id>", "模型 ID（可先 58pic models）")
    .option("--reference-url <url>", "垫图 URL（可选；纯文生图可省略）")
    .option("--picid <pid>", "素材 pid（可选）")
    .option("--prompt <text>", "描述词（写入 ai_title / prompt；与末尾描述词并存时本选项优先）")
    .option("--aspect <value>", "图片比例（如 \"16:9\"）或 model-capabilities 返回的 aspect ID")
    .option("--nums <n>", "生成张数 1-16", "1")
    .option(
      "--body-file <path>",
      "JSON 文件，若指定则与其它体字段合并（文件优先覆盖同名键）"
    )
    .argument(
      "[prompt...]",
      "描述词（多词以空格拼接；文生图只需模型 + 提示词；与 --prompt 并存时 --prompt 优先）"
    )
    .action(
      async (
        promptParts: string[],
        opts: {
          apiKey?: string;
          baseUrl?: string;
          format: string;
          model: string;
          referenceUrl?: string;
          picid?: string;
          prompt?: string;
          aspect?: string;
          nums: string;
          bodyFile?: string;
        }
      ) => {
        const file = await loadConfig();
        const ctx = await getCtx(opts, file);
        let extra: Record<string, unknown> = {};
        if (opts.bodyFile) {
          const raw = await readFile(opts.bodyFile, "utf8");
          extra = JSON.parse(raw) as Record<string, unknown>;
        }
        const body: Record<string, unknown> = {
          media_type: "image",
          model: /^\d+$/.test(opts.model) ? Number(opts.model) : opts.model,
          generate_nums: Number(opts.nums) || 1,
        };
        Object.assign(body, extra);
        if (opts.aspect) body.Aspect = opts.aspect;
        if (opts.referenceUrl) {
          body.reference_image_url = opts.referenceUrl;
        } else {
          const ref = body.reference_image_url;
          if (ref === "" || ref === null) {
            delete body.reference_image_url;
          }
        }
        if (opts.picid) body.picid = opts.picid;
        const positional = Array.isArray(promptParts)
          ? promptParts.join(" ").trim()
          : "";
        const flagPrompt = (opts.prompt ?? "").trim();
        const effectivePrompt = flagPrompt || positional;
        if (effectivePrompt) {
          body.ai_title = effectivePrompt;
          body.prompt = effectivePrompt;
        }
        const { http, body: resp } = await pic58Request(ctx, "same-style", {
          method: "POST",
          jsonBody: body,
        });
        printEnvelope(fmtOf(opts.format), http, resp, true);
      }
    );

  const status = program
    .command("same-style-status")
    .description("快捷：查询做同款任务状态")
    .argument("<ai_id>", "任务 ai_id");
  addGlobalOpts(status);
  status.action(
    async (
      aiId: string,
      opts: { apiKey?: string; baseUrl?: string; format: string }
    ) => {
      const file = await loadConfig();
      const ctx = await getCtx(opts, file);
      const url = `${routeUrl(ctx.baseUrl, "same-style-status")}&ai_id=${encodeURIComponent(aiId)}`;
      const headers = new Headers();
      headers.set("Authorization", `Bearer ${ctx.apiKey}`);
      const res = await fetch(url, { headers });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
      printEnvelope(fmtOf(opts.format), res.status, parsed, true);
    }
  );

  const genVideo = program
    .command("generate-video")
    .description(
      "快捷：提交视频生成任务（文生视频 / 图生视频）；返回 ai_id 后可用 same-style-status 查进度"
    );
  addGlobalOpts(genVideo);
  genVideo
    .requiredOption("-m, --model <id>", "模型 ID（可先 58pic models）")
    .option("--reference-url <url>", "参考图 URL（图生视频时传）")
    .option("--prompt <text>", "描述词")
    .option(
      "--aspect <value>",
      "视频比例（如 \"16:9\"、\"9:16\"）或 model-capabilities 返回的 aspect ID"
    )
    .option(
      "--resolution <value>",
      "清晰度（如 \"1080p\"、\"720p\"、\"4K\"）或 resolution_options ID"
    )
    .option(
      "--duration <value>",
      "时长（如 \"5s\"、\"5秒\"、\"10\"）或 duration_options ID"
    )
    .option("--end-frame-url <url>", "结束帧图 URL（部分模型支持）")
    .option(
      "--body-file <path>",
      "JSON 文件，若指定则与其它体字段合并（文件优先覆盖同名键）"
    )
    .argument(
      "[prompt...]",
      "描述词（多词以空格拼接；与 --prompt 并存时 --prompt 优先）"
    )
    .action(
      async (
        promptParts: string[],
        opts: {
          apiKey?: string;
          baseUrl?: string;
          format: string;
          model: string;
          referenceUrl?: string;
          prompt?: string;
          aspect?: string;
          resolution?: string;
          duration?: string;
          endFrameUrl?: string;
          bodyFile?: string;
        }
      ) => {
        const file = await loadConfig();
        const ctx = await getCtx(opts, file);
        let extra: Record<string, unknown> = {};
        if (opts.bodyFile) {
          const raw = await readFile(opts.bodyFile, "utf8");
          extra = JSON.parse(raw) as Record<string, unknown>;
        }
        const body: Record<string, unknown> = {
          media_type: "video",
          model: /^\d+$/.test(opts.model) ? Number(opts.model) : opts.model,
        };
        Object.assign(body, extra);
        if (opts.aspect) body.Aspect = opts.aspect;
        if (opts.resolution) body.video_resolution = opts.resolution;
        if (opts.duration) body.video_duration = opts.duration;
        if (opts.referenceUrl) body.reference_image_url = opts.referenceUrl;
        if (opts.endFrameUrl) body.end_frame_url = opts.endFrameUrl;
        const positional = Array.isArray(promptParts)
          ? promptParts.join(" ").trim()
          : "";
        const flagPrompt = (opts.prompt ?? "").trim();
        const effectivePrompt = flagPrompt || positional;
        if (effectivePrompt) {
          body.ai_title = effectivePrompt;
          body.prompt = effectivePrompt;
        }
        const { http, body: resp } = await pic58Request(ctx, "same-style", {
          method: "POST",
          jsonBody: body,
        });
        printEnvelope(fmtOf(opts.format), http, resp, true);
      }
    );

  const categories = program
    .command("categories")
    .description(
      "快捷：GET open-platform/categories（发布AI作品用三级分类树 did/kid/bid，一次性拿全量）"
    );
  addGlobalOpts(categories);
  categories.action(
    async (opts: { apiKey?: string; baseUrl?: string; format: string }) => {
      const file = await loadConfig();
      const ctx = await getCtx(opts, file);
      const { http, body } = await pic58Request(ctx, "categories", {
        method: "GET",
      });
      printEnvelope(fmtOf(opts.format), http, body, true);
    }
  );

  const suggestMeta = program
    .command("suggest-meta")
    .description(
      "快捷：POST open-platform/suggest-meta（title/keyword/分类缺失时的AI补全建议，仅限设计师身份账号，响应可能需要数秒到十几秒）"
    );
  addGlobalOpts(suggestMeta);
  suggestMeta
    .requiredOption(
      "--ai-id <id>",
      "AI 生成任务 id（ai_detail_id，即 same-style-status 返回的 details[].id）"
    )
    .action(
      async (opts: {
        apiKey?: string;
        baseUrl?: string;
        format: string;
        aiId: string;
      }) => {
        const file = await loadConfig();
        const ctx = await getCtx(opts, file);
        const body: Record<string, unknown> = {
          ai_detail_id: /^\d+$/.test(opts.aiId) ? Number(opts.aiId) : opts.aiId,
        };
        const { http, body: resp } = await pic58Request(ctx, "suggest-meta", {
          method: "POST",
          jsonBody: body,
        });
        printEnvelope(fmtOf(opts.format), http, resp, true);
      }
    );

  const publish = program
    .command("publish")
    .description(
      "快捷：POST open-platform/publish（发布AI作品为正式素材，默认直接送审，仅限设计师身份账号）"
    );
  addGlobalOpts(publish);
  publish
    .requiredOption("--ai-id <id>", "AI 生成任务 id（ai_detail_id）")
    .requiredOption(
      "--category-did <did>",
      "一级分类 id（AI 建议分类固定为 60，也可用 58pic categories 选其他分类）"
    )
    .requiredOption("--category-kid <kid>", "二级分类 id（58pic categories 获取）")
    .requiredOption("--category-bid <bid>", "三级分类 id（58pic categories 获取）")
    .requiredOption("--title <text>", "作品标题")
    .option(
      "--keyword <word>",
      "关键词，至少需要 5 个；本参数可重复传入多次",
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .option("--theme-id <id>", "主题 id（可选）")
    .option(
      "--no-submit",
      "只存草稿，不直接送审（默认不加此参数即直接送审，送审前请再次和用户确认）"
    )
    .action(
      async (opts: {
        apiKey?: string;
        baseUrl?: string;
        format: string;
        aiId: string;
        categoryDid: string;
        categoryKid: string;
        categoryBid: string;
        title: string;
        keyword: string[];
        themeId?: string;
        submit: boolean;
      }) => {
        const file = await loadConfig();
        const ctx = await getCtx(opts, file);
        const body: Record<string, unknown> = {
          ai_detail_id: /^\d+$/.test(opts.aiId) ? Number(opts.aiId) : opts.aiId,
          did: Number(opts.categoryDid),
          kid: Number(opts.categoryKid),
          bid: Number(opts.categoryBid),
          title: opts.title,
          keyword: opts.keyword,
          is_submit: opts.submit ? 1 : 0,
        };
        if (opts.themeId) body.theme_id = Number(opts.themeId);
        const { http, body: resp } = await pic58Request(ctx, "publish", {
          method: "POST",
          jsonBody: body,
        });
        printEnvelope(fmtOf(opts.format), http, resp, true);
      }
    );

  const apiCmd = program
    .command("api")
    .description(
      "通用调用：指定路由名（含或不含 open-platform/ 前缀）与 JSON 请求体"
    )
    .argument("<route>", "例如 search-images 或 open-platform/search-images")
    .option("-X, --method <m>", "HTTP 方法", "POST")
    .option("--body <json>", "请求 JSON 字符串")
    .option("--body-file <path>", "从文件读 JSON");
  addGlobalOpts(apiCmd);
  apiCmd.action(
    async (
      route: string,
      opts: {
        apiKey?: string;
        baseUrl?: string;
        format: string;
        method: string;
        body?: string;
        bodyFile?: string;
      }
    ) => {
      const file = await loadConfig();
      const ctx = await getCtx(opts, file);
      const method = opts.method.toUpperCase();
      let jsonBody: unknown = undefined;
      if (opts.bodyFile) {
        jsonBody = JSON.parse(await readFile(opts.bodyFile, "utf8"));
      } else if (opts.body) {
        jsonBody = JSON.parse(opts.body);
      }
      const r = route.replace(/^open-platform\//, "");
      if (method === "GET" || method === "HEAD") {
        const u = new URL(routeUrl(ctx.baseUrl, r));
        if (jsonBody && typeof jsonBody === "object") {
          for (const [k, v] of Object.entries(
            jsonBody as Record<string, string>
          )) {
            u.searchParams.set(k, String(v));
          }
        }
        const headers = new Headers();
        headers.set("Authorization", `Bearer ${ctx.apiKey}`);
        const res = await fetch(u, { method, headers });
        const text = await res.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }
        printEnvelope(fmtOf(opts.format), res.status, parsed, true);
        return;
      }
      const { http, body } = await pic58Request(ctx, r, {
        method,
        jsonBody,
      });
      printEnvelope(fmtOf(opts.format), http, body, true);
    }
  );

  program
    .command("dry-run")
    .description("仅打印将要请求的 URL 与 Method（不发起网络请求）")
    .argument("<route>", "路由片段，如 search-images")
    .option("-X, --method <m>", "HTTP 方法", "POST")
    .option("--base-url <url>", `默认 ${DEFAULT_BASE}`, DEFAULT_BASE)
    .action((route: string, o: { method: string; baseUrl: string }) => {
      const url = routeUrl(o.baseUrl ?? DEFAULT_BASE, route);
      console.log(
        JSON.stringify({ method: o.method.toUpperCase(), url }, null, 2)
      );
    });

  await program.parseAsync(process.argv);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
