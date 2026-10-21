# 对话阅读示例

**你：**

备份文件怎么安排？

---

**ChatGPT：**

**建议保留两种文件：**

| 文件 | 用途 |
| --- | --- |
| JSON | 保存原始数据，便于后续处理 |
| Markdown | 直接阅读对话 |

日常使用时：

1. 打开 Markdown 阅读。
2. 需要处理原始数据时，再查看 JSON。

---

**你：**

给我一个读取 JSON 的例子。

---

**ChatGPT：**

可以使用下面这段 JavaScript：

```js
const conversation = JSON.parse(content);
console.log(conversation.title);
```

这样就能读取对话标题。
