// 技能模板的宿主适配渲染:SKILL.md 正文里嵌 {{KEY}} 占位,init 铺入时按平台 templateVars 替换。
// 单一技能源 + 每平台变量表,避免按平台拷贝 SKILL.md 造成漂移(设计决策见 docs/multi-agent-plan.md D1)。

/** 返回 installFile 可用的 transform:替换 vars 覆盖的占位,未覆盖的 {{X}} 保持原样。 */
export function renderTemplate(vars: Record<string, string>): (content: string) => string {
  return (content: string): string =>
    content.replace(/\{\{([A-Z0-9_]+)\}\}/g, (whole, key: string) =>
      key in vars ? vars[key] : whole,
    );
}
