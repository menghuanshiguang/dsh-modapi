// 复制到 $DSH_HOME/modapi/mods/fabric-demo/ 后重启 DSH 即加载。
// 清单已声明 requires，加载器会先校验模块版本，不满足就整个 mod 不加载。
const blocks = modapi.registry.create('blocks');
blocks.register('fabric-demo:ruby', { hardness: 3 });
blocks.register('fabric-demo:slate', { hardness: 1.5 });

modapi.events.create('fabric-demo:greeting');
modapi.events.on('fabric-demo:greeting', (payload) => {
  modapi.log.info('[fabric-demo] greeting', payload);
});

function checkstart() {
  modapi.events.fire('fabric-demo:greeting', { id: 'fabric-demo' });
  公告({
    level: 'success',
    title: 'Fabric 风格 mod 已加载',
    body: 'registry: ' + blocks.keys().join(','),
    kind: 'fabric-demo.ready',
  }).show();
}
