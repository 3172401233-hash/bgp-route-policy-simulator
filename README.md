# bgp-route-policy-simulator

纯 Node.js 实现的 BGP 路由策略模拟器，支持：

- eBGP / iBGP 邻居关系与逐跳事件驱动收敛
- prefix-list 前缀过滤（精确匹配、`ge`/`le` 范围匹配）
- route-map 策略（`permit`/`deny`、AS-PATH 正则、community 匹配、属性改写、AS-PATH prepend）
- BGP 最优路径选择（local-pref → AS-PATH 长度 → origin → MED → eBGP 优先 → 确定性平局）
- 邻居故障撤销与恢复后的重新收敛、多路径故障切换
- AS-PATH 环路检测与 iBGP 水平分割

零运行时依赖，使用 ES Modules 与内置 `node:test`。

## 环境要求

- Node.js >= 20（开发目标版本 Node.js 24，全部 API 在 20/22/24 上兼容）

## 快速开始

```bash
npm test
node bin/simulate.js examples/scenario.json
```

## 编程接口

```js
import { Network } from './src/index.js';

const network = new Network({
  routers: [
    { id: 'R1', as: 65001 },
    { id: 'R2', as: 65002 },
  ],
  links: [
    { a: 'R1', b: 'R2', aPolicy: { export: 'RM-EXPORT' } },
  ],
  prefixLists: {
    'PL-DENY': [
      { sequence: 10, prefix: '10.0.0.0/8', action: 'deny', ge: 24, le: 32 },
    ],
  },
  routeMaps: {
    'RM-EXPORT': [
      { sequence: 10, action: 'deny', match: { prefixList: 'PL-DENY' } },
      { sequence: 20, action: 'permit', set: { localPref: 200, communityAdd: ['65001:10'] } },
    ],
  },
});

network.originate('R1', '10.1.0.0/24');
network.converge();

const before = network.snapshot();
network.failNeighbor('R1', 'R2');
network.converge();
const changes = network.diff(before);
```

### Network 方法

- `new Network(config)`：构建拓扑与策略，`config` 包含 `routers`、`links`、`prefixLists`、`routeMaps`
- `originate(routerId, prefix, attributes?)`：路由器始发前缀，属性支持 `med`、`localPref`、`origin`、`communities`
- `converge({ maxEvents }?)`：处理事件队列直到收敛，返回处理的事件数；超过上限抛出振荡错误
- `failNeighbor(a, b)` / `restoreNeighbor(a, b)`：模拟邻居故障与恢复
- `snapshot()`：返回所有路由器当前最优路由表
- `diff(before, after?)`：对比两份快照，输出逐前缀变化

### 链路策略配置

链路对象使用 `aPolicy` / `bPolicy` 分别配置两端策略，避免与端点字段 `a`/`b` 冲突：

```js
{ a: 'R1', b: 'R2', aPolicy: { export: 'RM-OUT' }, bPolicy: { import: 'RM-IN' } }
```

也可以用链路级 `import` / `export` 对两端同时生效。

### route-map 能力

- `match.prefixList`：引用 prefix-list，显式 `deny` 条目直接拒绝，未命中则继续下一条
- `match.asPath`：AS-PATH 正则（针对空格分隔的 AS 号序列）
- `match.community`：community 匹配，多个值为 AND 关系
- `set.localPref` / `set.med`：改写属性
- `set.community` / `set.communityAdd` / `set.communityRemove`：community 操作
- `set.asPathPrepend`：eBGP 出口通告时在 AS-PATH 前置本端 AS

未命中任何子句时按隐式 `deny` 处理，与真实 route-map 行为一致。

## 场景文件

`examples/scenario.json` 是完整 CLI 场景，包含初始通告、故障、恢复和再次通告，结构与 `Network` 配置一致，额外支持：

- `announce`：初始始发前缀列表
- `steps`：按顺序执行的 `fail` / `restore` / `announce` 步骤

## 目录结构

```
src/
  prefix.js    # CIDR 解析与 prefix-list
  policy.js    # route-map 匹配与 set 改写
  decision.js  # 最优路径比较
  router.js    # 路由器 RIB、通告、撤销
  network.js   # 拓扑、事件队列、收敛、快照对比
bin/
  simulate.js  # CLI 场景执行器
test/          # node:test 测试（28 个用例）
examples/      # 示例场景
```

## 建模范围与简化

- 仅模拟控制平面，不模拟 TCP/BGP 报文格式、定时器与 OPEN/CAPABILITY 协商
- MED 仅在同源候选间比较的真实规则被简化为全局比较
- 不实现路由反射器、联盟、地址族（仅 IPv4 单播）
