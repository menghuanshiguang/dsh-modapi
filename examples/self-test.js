// 四个域的真机自测：结果直接进公告，浏览器右下角能看到。
// 放进 $DSH_HOME/modapi/scripts/ 后重启。
async function checkstart() {
  const report = { api: modapi.version }
  try { report.workspaces = (await work.list()).length } catch (error) { report.workspaces = String(error.code || error) }
  try { report.sessions = (await session.list()).length } catch (error) { report.sessions = String(error.code || error) }
  try { report.tools = (await tool.list()).length } catch (error) { report.tools = String(error.code || error) }
  try {
    const entries = await fs.list('.')
    report.files = entries.length
    report.first = entries.slice(0, 3).map((item) => item.name).join(',')
  } catch (error) { report.files = String(error.code || error) }
  try { report.target = (await fs.resolve('.')).displayPath } catch (error) { report.target = String(error.code || error) }
  公告('modapi 自测：' + JSON.stringify(report), { level: 'success' }).show()
}
