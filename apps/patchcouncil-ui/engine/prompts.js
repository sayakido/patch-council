const fs = require("node:fs");
const path = require("node:path");

const promptsDir = path.join(__dirname, "prompts");

function renderPrompt(templateName, values) {
  const filePath = path.join(promptsDir, templateName);
  const template = fs.readFileSync(filePath, "utf8");
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => {
    return key in values ? values[key] : "";
  });
}

module.exports = { renderPrompt };
