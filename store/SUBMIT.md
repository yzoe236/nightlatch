# 提交到 Chrome 应用商店 — 逐步操作单

> **为什么这一段必须你自己点：** Chrome 从浏览器层面禁止任何扩展脚本操作应用商店和开发者后台
> （尝试时会直接报 *"The extensions gallery cannot be scripted"*）。这是浏览器的安全设计，
> 任何自动化工具都进不去。另外登录 Google 账号、签署开发者协议、支付这三件事，也都属于
> 必须由你本人完成的动作。
>
> 好消息：**所有内容都已备好，你只需要复制粘贴和点按钮，全程约 20 分钟。**

需要的东西全在 `D:\dev\nightlatch\`：

| 用途 | 文件 |
|---|---|
| 上传的安装包 | `dist\nightlatch-store.zip` |
| 商店图标 | `icons\icon128.png` |
| 截图 ×4 | `store\screenshot-1…4-*.png` |
| 所有要粘贴的文字 | `store\LISTING.md` ← **另开一个窗口对照着抄** |
| 隐私政策网址 | `https://yzoe236.github.io/nightlatch/privacy.html` （已上线） |

---

## 第 0 步 · 用哪个 Google 账号（决定后不可更改）

用 **yzoe314 那个 Gmail** 登录 <https://chrome.google.com/webstore/devconsole>。

⚠️ **开发者账号的邮箱之后永远无法修改**，而且所有审核结果、警告、下架通知都发到这个邮箱——
确认这是你会长期查看的邮箱。（跟 GitHub 用的 yzoe236 是两回事，不冲突，不用统一。）

## 第 1 步 · 注册 + 付 $5

1. 登录后会出现注册页 → 阅读并**接受开发者协议**（这是法律文件，必须你本人确认）
2. 支付 **$5**（一次性，终身有效，一个账号最多 20 个扩展）
3. 付款完成后即可开始上传

## 第 2 步 · 声明 non-trader（别跳过，这条保护你的隐私）

进 **Account（账号）** 页 → 找到 trader / non-trader 声明 → 选择 **non-trader（非经营者）**。

理由：欧盟规定要求"经营者"在商店页**公开姓名、住址、电话**。免费扩展不需要经营者身份，
选 non-trader 就**不会公示你的家庭住址**。（那个印度竞品的家庭住址和手机号被挂在商店页上，
就是因为申报了 trader。将来真要收费时再改，并且用商业地址，绝不能用家里地址。）

## 第 3 步 · 新建条目并上传

**Items → + New item** → 上传 `dist\nightlatch-store.zip` → 等待解析完成。

解析后它会自动读出名称 `Nightlatch — Profile Lock for Google Chrome™`，正常。

## 第 4 步 · 填 Store listing（商品详情）

对照 `store\LISTING.md` 逐项粘贴：

- [ ] **Summary / 摘要** ← LISTING.md「Short description」整段
- [ ] **Description / 详细说明** ← LISTING.md「Detailed description」代码块内全部内容
      （⚠️ 一定要包含最后那行商标归属声明，这是标题里能出现 "Google Chrome™" 的前提）
- [ ] **Category / 类别** → `Privacy & Security`
- [ ] **Language / 语言** → English
- [ ] **Store icon** → 上传 `icons\icon128.png`
- [ ] **Screenshots** → 依次上传 4 张（顺序有讲究，第 2 张跨设备对比是最强卖点，别放最后）

## 第 5 步 · 填 Privacy practices（隐私实践）

这一页填不好最容易被打回，逐项按下面填：

- [ ] **Single purpose / 单一用途** ← LISTING.md「Single purpose」那一句
- [ ] **Permission justifications / 权限理由** ← LISTING.md 表格里 **6 条逐条粘贴**
      （`storage` / `idle` / `tabs` / `scripting` / `alarms` / `host permissions`）
- [ ] **Remote code / 远程代码** → **No**（所有代码都在包里，不加载任何外部脚本）
- [ ] **Data usage / 数据用途** → 每一类都勾 **不收集**；下方三条合规声明全部勾选
- [ ] **Privacy policy URL** → `https://yzoe236.github.io/nightlatch/privacy.html`

## 第 6 步 · 可见性选 Unlisted，然后提交

**Visibility → Unlisted（不公开列出）** → **Submit for review**。

Unlisted 走的是**同样的完整审核**，但只有拿到链接的人能安装。等你在两台电脑上验证完
核心行为（家里解锁后实验室仍然锁着），再改成 Public 即可，改可见性不需要重新审核。

---

## 提交之后

- **审核时间**：一般 2–7 天。新账号 + `<all_urls>` 宽权限大概率触发人工审核，可能拖到 1–3 周。
- ⚠️ **千万别取消重交**——那会让你重新排队，只会更慢。耐心等邮件。
- **被驳回怎么办**：驳回邮件会写明原因。若是名称问题，用 LISTING.md 里备好的替代标题
  `Nightlatch — Profile Lock for Shared Computers`，改完重交即可，其他内容都不用动。
- **通过之后**：把商店链接发我，我会替换 `README.md` 和 `docs/INSTALL.md` 里的
  `<!-- STORE_URL -->` 占位符，GitHub 那边就彻底完工。

## 上架后的更新流程（以后改代码时）

```bash
cd D:\dev\nightlatch
# 改 manifest.json 里的 version（例如 0.4.0 → 0.4.1，必须比线上高）
node tools/package.js --store
# 到 devconsole 上传新的 dist/nightlatch-store.zip → Submit
```
