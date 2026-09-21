// <script>
(() => {
  const CONTAINER_SELECTOR = '.functions-container';
  const PANEL_ID = 'ipv6_monitor_panel';

  const BUILTIN_SCRIPT = `#!/system/bin/sh
# IPv6 失效自重启基带网络
# 只检测 IPv6；IPv4 正常不触发

BASE_DIR="/data/kano_ipv6_monitor"
LOG_DIR="/sdcard/kano_ipv6"
LOG_FILE="\${LOG_DIR}/ipv6_monitor.log"
PID_FILE="\${BASE_DIR}/service.pid"
STOP_FLAG="\${BASE_DIR}/stop_flag"

CHECK_INTERVAL=300
COOLDOWN=1800
FAIL_THRESHOLD=2
PING_RETRY=3
PING_RETRY_SLEEP=2
WAIT_AFTER_AT=90

IP1="2400:3200::1"
IP2="2606:4700:4700::1111"
IP3="2001:4860:4860::8888"
NAME1="阿里云"
NAME2="Cloudflare"
NAME3="Google"

mkdir -p "\$BASE_DIR" "\$LOG_DIR" 2>/dev/null
touch "\$LOG_FILE" 2>/dev/null

log() {
    echo "\$(date '+%Y-%m-%d %H:%M:%S') \$*" >> "\$LOG_FILE"
    tail -n 500 "\$LOG_FILE" > "\$LOG_FILE.tmp" 2>/dev/null && mv "\$LOG_FILE.tmp" "\$LOG_FILE"
}

ping_one() {
    local target="\$1"
    if command -v ping6 >/dev/null 2>&1; then
        ping6 -c 1 -W 3 "\$target" >/dev/null 2>&1
    else
        ping -6 -c 1 -W 3 "\$target" >/dev/null 2>&1
    fi
}

check_ipv6_once() {
    local ok1=0 ok2=0 ok3=0
    ping_one "\$IP1" && ok1=1
    ping_one "\$IP2" && ok2=1
    ping_one "\$IP3" && ok3=1
    if [ "\$ok1" -eq 1 ] || [ "\$ok2" -eq 1 ] || [ "\$ok3" -eq 1 ]; then
        local s1=FAIL s2=FAIL s3=FAIL
        [ "\$ok1" -eq 1 ] && s1=OK
        [ "\$ok2" -eq 1 ] && s2=OK
        [ "\$ok3" -eq 1 ] && s3=OK
        log "[检测] \${NAME1}=\$s1, \${NAME2}=\$s2, \${NAME3}=\$s3 -> PASS"
        return 0
    fi
    log "[检测] \${NAME1}=FAIL, \${NAME2}=FAIL, \${NAME3}=FAIL -> FAIL"
    return 1
}

check_ipv6() {
    local retry=0
    while [ "\$retry" -lt "\$PING_RETRY" ]; do
        if check_ipv6_once; then
            return 0
        fi
        retry=\$((retry + 1))
        [ "\$retry" -lt "\$PING_RETRY" ] && sleep "\$PING_RETRY_SLEEP"
    done
    log "[检测] 本周期连续 \$PING_RETRY 次失败 -> FAIL"
    return 1
}

send_at_restart() {
    local out=""
    if command -v sendat >/dev/null 2>&1; then
        out=\$(sendat -c "AT+CFUN=1,1" 2>&1)
        log "[重启] sendat -c 返回: \$out"
        if echo "\$out" | grep -qi 'OK'; then
            return 0
        fi
        out=\$(sendat -c "AT+CFUN=1,1" -n 0 2>&1)
        log "[重启] sendat -c -n 0 返回: \$out"
        if echo "\$out" | grep -qi 'OK'; then
            return 0
        fi
    fi
    if [ -x /data/data/com.minikano.f50_sms/files/ufi_req ]; then
        out=\$(/data/data/com.minikano.f50_sms/files/ufi_req -e "/api/AT?command=AT%2BCFUN%3D1%2C1&slot=0" 2>&1)
        log "[重启] ufi_req 返回: \$out"
        if echo "\$out" | grep -qi 'OK'; then
            return 0
        fi
    fi
    log "[重启] 所有方式均失败，本次不进入冷却"
    return 1
}

verify_after_restart() {
    log "[恢复] AT 已发送，等待 \${WAIT_AFTER_AT}s 后复检"
    sleep "\$WAIT_AFTER_AT"
    if check_ipv6; then
        log "[恢复] IPv6 已恢复"
        return 0
    fi
    log "[恢复] 等待后仍未恢复"
    return 1
}

run_one_check() {
    log "[手动] 开始立即检测"
    if check_ipv6; then
        echo "OK"
        log "[手动] 结果：IPv6 正常"
        return 0
    fi
    echo "FAIL"
    log "[手动] 结果：IPv6 异常"
    return 1
}

run_service() {
    log "服务启动 PID=\$\$"
    log "配置: 间隔=\${CHECK_INTERVAL}s 阈值=\$FAIL_THRESHOLD 冷却=\${COOLDOWN}s AT后等待=\${WAIT_AFTER_AT}s"
    local attempt=0
    while [ "\$attempt" -lt 4 ]; do
        if check_ipv6; then
            log "[预检] IPv6 已就绪"
            break
        fi
        attempt=\$((attempt + 1))
        [ "\$attempt" -lt 4 ] && sleep 5
    done
    local fail_count=0
    local last_restart=0
    while true; do
        [ -f "\$STOP_FLAG" ] && { rm -f "\$STOP_FLAG"; log "收到停止请求"; return 0; }
        local now=\$(date +%s)
        local in_cooldown=0
        if [ "\$last_restart" -gt 0 ]; then
            if [ \$((now - last_restart)) -lt "\$COOLDOWN" ]; then
                in_cooldown=1
            else
                last_restart=0
                log "[冷却] 结束，恢复自动修复"
            fi
        fi
        if check_ipv6; then
            [ "\$fail_count" -gt 0 ] && log "[恢复] IPv6 恢复，清零失败计数"
            fail_count=0
        else
            fail_count=\$((fail_count + 1))
            log "[主循环] IPv6 异常 \$fail_count/\$FAIL_THRESHOLD"
            if [ "\$fail_count" -ge "\$FAIL_THRESHOLD" ]; then
                if [ "\$in_cooldown" -eq 0 ]; then
                    log "[主循环] 达到阈值，准备重启基带"
                    if send_at_restart; then
                        last_restart=\$(date +%s)
                        fail_count=0
                        verify_after_restart
                    else
                        log "[主循环] AT 未成功发送，不进入冷却"
                        fail_count=\$((FAIL_THRESHOLD - 1))
                    fi
                else
                    log "[主循环] 冷却中，跳过重启"
                fi
            fi
        fi
        local slept=0
        while [ "\$slept" -lt "\$CHECK_INTERVAL" ]; do
            [ -f "\$STOP_FLAG" ] && { rm -f "\$STOP_FLAG"; log "收到停止请求"; return 0; }
            sleep 5
            slept=\$((slept + 5))
        done
    done
}

case "\$1" in
    start)
        mkdir -p "\$BASE_DIR" "\$LOG_DIR" 2>/dev/null
        rm -f "\$STOP_FLAG" 2>/dev/null
        if [ -f "\$PID_FILE" ] && kill -0 \$(cat "\$PID_FILE") 2>/dev/null; then
            echo "服务已在运行 (PID \$(cat "\$PID_FILE"))"
            exit 1
        fi
        nohup /system/bin/sh "\$0" run >/dev/null 2>&1 &
        sleep 1
        if [ -f "\$PID_FILE" ] && kill -0 \$(cat "\$PID_FILE") 2>/dev/null; then
            echo "started"
            log "后台服务已启动 PID=\$(cat "\$PID_FILE")"
            exit 0
        fi
        echo "启动失败"
        exit 1
        ;;
    stop)
        if [ -f "\$PID_FILE" ]; then
            pid=\$(cat "\$PID_FILE" 2>/dev/null)
            [ -n "\$pid" ] && { echo stop > "\$STOP_FLAG"; kill -TERM "\$pid" 2>/dev/null; sleep 1; kill -9 "\$pid" 2>/dev/null; }
        fi
        rm -f "\$PID_FILE" "\$STOP_FLAG"
        echo "已停止"
        exit 0
        ;;
    restart)
        "\$0" stop
        sleep 1
        "\$0" start
        ;;
    status)
        if [ -f "\$PID_FILE" ] && kill -0 \$(cat "\$PID_FILE") 2>/dev/null; then
            echo "运行中 (PID \$(cat "\$PID_FILE"))"
            exit 0
        fi
        echo "未运行"
        exit 1
        ;;
    check)
        run_one_check
        exit \$?
        ;;
    run)
        echo \$\$ > "\$PID_FILE"
        run_service
        rm -f "\$PID_FILE"
        ;;
    *)
        echo "用法: \$0 {start|stop|restart|status|check}"
        exit 1
        ;;
esac
`;

  const BASE_DIR = '/data/kano_ipv6_monitor';
  const SERVICE_SH = `${BASE_DIR}/service.sh`;
  const PID_FILE = `${BASE_DIR}/service.pid`;
  const STOP_FLAG = `${BASE_DIR}/stop_flag`;
  const LOG_DIR = '/sdcard/kano_ipv6';
  const LOG_FILE = `${LOG_DIR}/ipv6_monitor.log`;
  const BOOT_SH = '/sdcard/ufi_tools_boot.sh';
  const BOOT_LINE = `sh ${SERVICE_SH} start`;
  const INSTALLED_FLAG = `${BASE_DIR}/.installed`;
  const BOOT_FLAG = `${BASE_DIR}/.boot_enabled`;

  const state = {
    busy: false,
    serviceRunning: false,
    bootEnabled: false,
    installed: false,
    ipv6Ok: null, // null未知 true正常 false异常
    autoRefresh: false,
    autoRefreshTimer: null,
    collapsed: true,
    refreshedAt: ''
  };

  const run = async (cmd, timeout = 15000) => {
    const res = await runShellWithRoot(cmd + ' 2>&1', timeout);
    return { ok: Boolean(res?.success), content: String(res?.content || '').trim() };
  };

  const shellQuote = (v) => `'${String(v ?? '').replace(/'/g, `'\\''`)}'`;
  const shellBase64 = (text) => btoa(unescape(encodeURIComponent(text)));

  const highlightKeywords = (text) => {
    if (!text) return '';
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return escaped.replace(
      /\b(fail|ok|pass|FAIL|OK|PASS)\b|失败|成功|异常|恢复|重启|冷却/gi,
      (match) => {
        const lower = match.toLowerCase();
        let color = '#c8d6e5';
        if (lower === 'fail' || match.includes('失败') || match.includes('异常')) color = '#DC143C';
        else if (lower === 'ok' || lower === 'pass' || match.includes('成功') || match.includes('恢复')) color = '#3CB371';
        else if (match.includes('重启') || match.includes('冷却')) color = '#ffd08a';
        return `<span style="color:${color};font-weight:600">${match}</span>`;
      }
    );
  };

  const checkAdvancedFunc = async () => {
    try {
      const res = await runShellWithRoot('whoami');
      return res.success && /root/.test(res.content || '');
    } catch { return false; }
  };

  const setBusy = (busy) => {
    state.busy = busy;
    document.querySelectorAll(`#${PANEL_ID} button`).forEach(el => { el.disabled = busy; });
  };

  const readStatus = async () => {
    const r = await run(`
      installed=0; boot=0; running=0
      [ -f ${shellQuote(INSTALLED_FLAG)} ] && installed=1
      [ -f ${shellQuote(BOOT_FLAG)} ] && boot=1
      [ -f ${shellQuote(PID_FILE)} ] && kill -0 $(cat ${shellQuote(PID_FILE)}) 2>/dev/null && running=1
      echo installed=$installed
      echo boot=$boot
      echo running=$running
    `);
    state.installed = /(^|\n)installed=1(\n|$)/.test(r.content) ||
      (await run(`[ -f ${shellQuote(SERVICE_SH)} ] && echo 1 || echo 0`)).content === '1';
    const bootByFlag = /(^|\n)boot=1(\n|$)/.test(r.content);
    const bootByFile = (await run(
      `grep -qxF ${shellQuote(BOOT_LINE)} ${shellQuote(BOOT_SH)} 2>/dev/null && echo 1 || echo 0`
    )).content === '1';
    state.bootEnabled = bootByFlag || bootByFile;
    state.serviceRunning = /(^|\n)running=1(\n|$)/.test(r.content);
  };

  // 从日志末尾推断 IPv6 状态
  const parseIpv6FromLog = (logText) => {
    if (!logText) return null;
    const lines = logText.split('\n').reverse();
    for (const line of lines) {
      if (/->\s*PASS/i.test(line) || /IPv6 正常|已恢复|已就绪/.test(line)) return true;
      if (/->\s*FAIL/i.test(line) || /IPv6 异常|仍未恢复/.test(line)) return false;
    }
    return null;
  };

  const loadLog = async () => {
    const r = await run(`tail -n 80 ${shellQuote(LOG_FILE)} 2>/dev/null || echo "（暂无日志）"`, 5000);
    const text = r.content || '（暂无日志）';
    const el = document.querySelector('#ipv6_log_text');
    if (el) {
      el.innerHTML = highlightKeywords(text);
      el.scrollTop = el.scrollHeight;
    }
    state.ipv6Ok = parseIpv6FromLog(text);
    state.refreshedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const timeEl = document.querySelector('#ipv6_log_time');
    if (timeEl) timeEl.textContent = state.refreshedAt;
    updateUI();
  };

  const installService = async () => {
    if (!(await checkAdvancedFunc())) { createToast('请先启用高级功能', 'pink'); return; }
    setBusy(true);
    createToast('正在部署...', 'blue');
    try {
      const encoded = shellBase64(BUILTIN_SCRIPT);
      await run(`mkdir -p ${shellQuote(BASE_DIR)} ${shellQuote(LOG_DIR)}`);
      await run(`echo '${encoded}' | base64 -d > ${shellQuote(SERVICE_SH)} 2>/dev/null || echo '${encoded}' | busybox base64 -d > ${shellQuote(SERVICE_SH)}`, 12000);
      await run(`chmod 755 ${shellQuote(SERVICE_SH)}`);
      await run(`touch ${shellQuote(INSTALLED_FLAG)}`);
      await run(`[ -f ${shellQuote(PID_FILE)} ] && kill -9 $(cat ${shellQuote(PID_FILE)}) 2>/dev/null || true; rm -f ${shellQuote(PID_FILE)} ${shellQuote(STOP_FLAG)}`, 8000);
      await run(`touch ${shellQuote(BOOT_SH)}; grep -qxF ${shellQuote(BOOT_LINE)} ${shellQuote(BOOT_SH)} || echo ${shellQuote(BOOT_LINE)} >> ${shellQuote(BOOT_SH)}; touch ${shellQuote(BOOT_FLAG)}`);
      const r = await run(`/system/bin/sh ${shellQuote(SERVICE_SH)} start`, 10000);
      createToast(
        r.content.includes('started') || r.content.includes('已在运行') ? '部署并启动成功' : ('启动返回: ' + (r.content || '未知')),
        r.content.includes('started') ? 'green' : 'orange'
      );
      await refreshAll(true);
    } catch (e) {
      createToast('部署失败: ' + e.message, 'red');
    } finally {
      setBusy(false);
    }
  };

  const startService = async () => {
    if (!(await checkAdvancedFunc())) { createToast('请先启用高级功能', 'pink'); return; }
    setBusy(true);
    try {
      const r = await run(`sh ${shellQuote(SERVICE_SH)} start`, 10000);
      createToast(r.content.includes('started') || r.content.includes('已在运行') ? '服务已启动' : (r.content || '启动失败'), r.ok ? 'green' : 'red');
      await refreshAll(true);
    } catch (e) {
      createToast('启动失败: ' + e.message, 'red');
    } finally {
      setBusy(false);
    }
  };

  const stopService = async () => {
    if (!(await checkAdvancedFunc())) { createToast('请先启用高级功能', 'pink'); return; }
    setBusy(true);
    try {
      await run(`sh ${shellQuote(SERVICE_SH)} stop`, 10000);
      createToast('服务已停止', 'green');
      await refreshAll(true);
    } catch (e) {
      createToast('停止失败: ' + e.message, 'red');
    } finally {
      setBusy(false);
    }
  };

  const restartService = async () => {
    if (!(await checkAdvancedFunc())) { createToast('请先启用高级功能', 'pink'); return; }
    setBusy(true);
    try {
      await run(`sh ${shellQuote(SERVICE_SH)} restart`, 12000);
      createToast('服务已重启', 'green');
      await refreshAll(true);
    } catch (e) {
      createToast('重启失败: ' + e.message, 'red');
    } finally {
      setBusy(false);
    }
  };

  const checkIpv6Now = async () => {
    if (!(await checkAdvancedFunc())) { createToast('请先启用高级功能', 'pink'); return; }
    createToast('正在检测 IPv6...', 'blue');
    const r = await run(`sh ${shellQuote(SERVICE_SH)} check`, 45000);
    if (r.content.includes('OK')) {
      state.ipv6Ok = true;
      createToast('IPv6 正常', 'green');
    } else if (r.content.includes('FAIL')) {
      state.ipv6Ok = false;
      createToast('IPv6 异常', 'red');
    } else {
      createToast(r.content || '请看日志', 'blue');
    }
    await loadLog();
  };

  const manualRestartBaseband = async () => {
    if (!(await checkAdvancedFunc())) { createToast('请先启用高级功能', 'pink'); return; }
    const key = 'ipv6_manual_at_confirm';
    if (!sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, '1');
      createToast('再点一次确认重启基带', 'pink');
      setTimeout(() => sessionStorage.removeItem(key), 3000);
      return;
    }
    sessionStorage.removeItem(key);
    setBusy(true);
    try {
      handleAT('AT+CFUN=1,1');
      await run(`echo "$(date '+%Y-%m-%d %H:%M:%S') [手动] handleAT 已发送 AT+CFUN=1,1" >> ${shellQuote(LOG_FILE)}`);
      createToast('已发送重启指令', 'green');
    } catch (e) {
      createToast('发送失败: ' + e.message, 'red');
    } finally {
      setBusy(false);
      await loadLog();
    }
  };

  const toggleBoot = async () => {
    if (!(await checkAdvancedFunc())) { createToast('请先启用高级功能', 'pink'); return; }
    setBusy(true);
    try {
      if (state.bootEnabled) {
        const escaped = BOOT_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        await run(`sed -i '/^${escaped}$/d' ${shellQuote(BOOT_SH)} 2>/dev/null || true`);
        await run(`rm -f ${shellQuote(BOOT_FLAG)}`);
        createToast('已取消开机自启', 'green');
      } else {
        await run(`touch ${shellQuote(BOOT_SH)}; grep -qxF ${shellQuote(BOOT_LINE)} ${shellQuote(BOOT_SH)} || echo ${shellQuote(BOOT_LINE)} >> ${shellQuote(BOOT_SH)}; touch ${shellQuote(BOOT_FLAG)}`);
        createToast('已设置开机自启', 'green');
      }
      await refreshAll(true);
    } catch (e) {
      createToast('切换失败: ' + e.message, 'red');
    } finally {
      setBusy(false);
    }
  };

  const clearLog = async () => {
    if (!(await checkAdvancedFunc())) { createToast('请先启用高级功能', 'pink'); return; }
    await run(`mkdir -p ${shellQuote(LOG_DIR)} && : > ${shellQuote(LOG_FILE)}`);
    state.ipv6Ok = null;
    await loadLog();
    createToast('日志已清空', 'green');
  };

  const uninstallService = async () => {
    if (!(await checkAdvancedFunc())) { createToast('请先启用高级功能', 'pink'); return; }
    const key = 'ipv6_uninstall_confirm';
    const btn = document.querySelector('#ipv6_uninstall_btn');
    if (!sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, '1');
      if (btn) btn.textContent = '⚠️ 再点确认';
      createToast('再点一次确认卸载', 'pink');
      setTimeout(() => {
        sessionStorage.removeItem(key);
        if (btn) btn.textContent = '卸载';
      }, 3000);
      return;
    }
    sessionStorage.removeItem(key);
    setBusy(true);
    try {
      await run(`sh ${shellQuote(SERVICE_SH)} stop`, 10000);
      await run(`sed -i '/kano_ipv6_monitor/d' ${shellQuote(BOOT_SH)} 2>/dev/null || true`);
      await run(`rm -rf ${shellQuote(BASE_DIR)}`);
      await refreshAll(true);
      createToast('卸载完成', 'green');
    } catch (e) {
      createToast('卸载异常: ' + e.message, 'red');
    } finally {
      setBusy(false);
      if (btn) btn.textContent = '卸载';
    }
  };

  const updateUI = () => {
    const root = document.querySelector(`#${PANEL_ID}`);
    if (!root) return;

    // 标题旁：服务状态
    const mini = root.querySelector('#ipv6_status_mini');
    if (mini) {
      if (state.serviceRunning) {
        mini.textContent = '● 运行中';
        mini.className = 'ipv6-chip good';
      } else if (state.installed) {
        mini.textContent = '○ 已停止';
        mini.className = 'ipv6-chip warn';
      } else {
        mini.textContent = '○ 未安装';
        mini.className = 'ipv6-chip bad';
      }
    }

    // 标题旁：IPv6 状态
    const ipv6El = root.querySelector('#ipv6_net_status');
    if (ipv6El) {
      if (state.ipv6Ok === true) {
        ipv6El.textContent = 'IPv6 正常';
        ipv6El.className = 'ipv6-chip good';
      } else if (state.ipv6Ok === false) {
        ipv6El.textContent = 'IPv6 异常';
        ipv6El.className = 'ipv6-chip bad';
      } else {
        ipv6El.textContent = 'IPv6 --';
        ipv6El.className = 'ipv6-chip';
      }
    }

    // 展开区里的状态
    const status = root.querySelector('#ipv6_status');
    if (status) {
      if (state.serviceRunning) {
        status.textContent = '运行中';
        status.className = 'ipv6-chip good';
      } else if (state.installed) {
        status.textContent = '已停止';
        status.className = 'ipv6-chip warn';
      } else {
        status.textContent = '未安装';
        status.className = 'ipv6-chip bad';
      }
    }
    const boot = root.querySelector('#ipv6_boot_status');
    if (boot) {
      boot.textContent = state.bootEnabled ? '已开启' : '未开启';
      boot.className = `ipv6-chip ${state.bootEnabled ? 'good' : 'warn'}`;
    }
  };

  const refreshAll = async (forceLog = false) => {
    await readStatus();
    if (forceLog || state.autoRefresh) await loadLog();
    else updateUI();
  };

  const startAutoRefresh = () => {
    if (state.autoRefreshTimer) clearInterval(state.autoRefreshTimer);
    state.autoRefresh = true;
    const btn = document.querySelector('#ipv6_toggle_auto');
    if (btn) btn.textContent = '⏸';
    state.autoRefreshTimer = setInterval(() => {
      if (!document.querySelector(`#${PANEL_ID}`)) {
        clearInterval(state.autoRefreshTimer);
        state.autoRefreshTimer = null;
        state.autoRefresh = false;
        return;
      }
      refreshAll(true);
    }, 5000);
  };

  const stopAutoRefresh = () => {
    state.autoRefresh = false;
    if (state.autoRefreshTimer) {
      clearInterval(state.autoRefreshTimer);
      state.autoRefreshTimer = null;
    }
    const btn = document.querySelector('#ipv6_toggle_auto');
    if (btn) btn.textContent = '▶';
  };

  const toggleCollapse = () => {
    const content = document.querySelector('#ipv6_collapse_content');
    const btn = document.querySelector('#ipv6_collapse_btn');
    if (!content) return;
    state.collapsed = !state.collapsed;
    if (state.collapsed) {
      content.style.height = '0px';
      if (btn) btn.textContent = '▽';
    } else {
      content.style.height = content.scrollHeight + 'px';
      if (btn) btn.textContent = '△';
      setTimeout(() => { content.style.height = 'auto'; }, 260);
      loadLog();
    }
  };

  const showHelp = () => {
    const { el, close } = createFixedToast('ipv6_help', `
      <div style="pointer-events:all;width:85vw;max-width:380px">
        <div class="title" style="margin:0">IPv6 失效自重启基带</div>
        <div style="margin:10px 0;font-size:13px;line-height:1.7">
          每 5 分钟检测 3 个 IPv6 公网地址，任一通即正常。<br>
          连续 2 次全失败自动重启基带 → <code>sendat -c "AT+CFUN=1,1"</code><br>
          重启成功后等 90 秒复检，再进入 30 分钟冷却。<br>
          By xueer20.
        </div>
        <div style="text-align:right">
          <button style="font-size:.64rem" id="close_ipv6_help">关闭</button>
        </div>
      </div>
    `);
    el?.querySelector('#close_ipv6_help')?.addEventListener('click', () => close());
  };

  const render = () => `
    <style>
      #${PANEL_ID}{width:100%;padding:0;margin:2px 0;box-sizing:border-box;font-family:inherit}
      #${PANEL_ID} *{box-sizing:border-box}
      #${PANEL_ID} .ipv6-panel{
        border-radius:10px;border:1px solid rgba(255,255,255,.08);
        background:rgba(255,255,255,.035);backdrop-filter:blur(10px);
        padding:5px 8px;width:100%
      }
      #${PANEL_ID} .ipv6-title{
        display:flex;align-items:center;gap:6px;cursor:pointer;
        flex-wrap:wrap;user-select:none;min-height:22px
      }
      #${PANEL_ID} .ipv6-title strong{font-size:.72rem;white-space:nowrap}
      #${PANEL_ID} .ipv6-chip{
        display:inline-flex;align-items:center;padding:1px 7px;border-radius:999px;
        font-size:.5rem;font-weight:700;background:rgba(255,255,255,.08);line-height:1.4
      }
      #${PANEL_ID} .ipv6-chip.good{color:#9dffbf;background:rgba(60,201,120,.18)}
      #${PANEL_ID} .ipv6-chip.warn{color:#ffd08a;background:rgba(255,173,51,.16)}
      #${PANEL_ID} .ipv6-chip.bad{color:#ffaaaa;background:rgba(255,80,80,.18)}
      #${PANEL_ID} .ipv6-actions{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
      #${PANEL_ID} .ipv6-actions button{font-size:.55rem;padding:3px 7px}
      #${PANEL_ID} .ipv6-grid{
        display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:4px 0 2px
      }
      #${PANEL_ID} .ipv6-stat-label{font-size:.48rem;opacity:.65;margin-bottom:2px}
      #${PANEL_ID} .ipv6-collapse-content{overflow:hidden;transition:height .25s ease;height:0}
      #${PANEL_ID} .ipv6-log-head{
        display:flex;align-items:center;justify-content:space-between;
        gap:6px;margin-top:8px;padding-top:6px;
        border-top:1px solid rgba(255,255,255,.06)
      }
      #${PANEL_ID} .ipv6-log-head span{font-size:.5rem;opacity:.7}
      #${PANEL_ID} .ipv6-log-area pre{
        width:100%;min-height:70px;max-height:160px;padding:4px 2px;
        border-radius:6px;background:transparent;color:#c8d6e5;
        font-size:.48rem;font-family:monospace;line-height:1.55;
        overflow:auto;margin:4px 0 0;white-space:pre-wrap;word-wrap:break-word
      }
      #${PANEL_ID} .ipv6-log-btns{display:flex;gap:3px}
      #${PANEL_ID} .ipv6-log-btns button{font-size:.45rem;padding:1px 6px}
    </style>
    <div id="${PANEL_ID}">
      <div class="ipv6-panel">
        <!-- 标题行：名称 + 服务状态 + IPv6状态 + 唯一展开按钮 -->
        <div class="ipv6-title" id="ipv6_title_click">
          <strong>🌐 IPv6 失效自重启基带</strong>
          <span class="ipv6-chip" id="ipv6_status_mini">○ 读取中</span>
          <span class="ipv6-chip" id="ipv6_net_status">IPv6 --</span>
          <button id="ipv6_collapse_btn" style="font-size:.5rem;padding:1px 7px;margin-left:auto">▽</button>
        </div>

        <!-- 唯一可收缩区域：状态 + 按钮 + 日志 全部在这里 -->
        <div class="ipv6-collapse-content" id="ipv6_collapse_content">
          <div class="ipv6-grid">
            <div>
              <div class="ipv6-stat-label">服务状态</div>
              <span class="ipv6-chip" id="ipv6_status">读取中</span>
            </div>
            <div>
              <div class="ipv6-stat-label">开机自启</div>
              <span class="ipv6-chip" id="ipv6_boot_status">读取中</span>
            </div>
          </div>

          <div class="ipv6-actions">
            <button id="ipv6_repair_btn" style="background:rgba(255,200,0,.2);color:#ffd700">🔧 安装/修复</button>
            <button id="ipv6_check_btn">🔍 立即检测</button>
            <button id="ipv6_start_btn">▶ 启动</button>
            <button id="ipv6_stop_btn">⏹ 停止</button>
            <button id="ipv6_restart_btn">⟳ 重启服务</button>
            <button id="ipv6_manual_btn" style="background:rgba(255,170,70,.15);color:#ffd08a">⚡ 手动重启基带</button>
            <button id="ipv6_boot_btn">设置/取消自启</button>
            <button id="ipv6_uninstall_btn">卸载</button>
            <button id="ipv6_refresh_btn">刷新</button>
            <button id="ipv6_help_btn" style="background:rgba(100,200,255,.15);color:#8fcbff">❓ 帮助</button>
          </div>

          <!-- 日志集成在同一面板底部 -->
          <div class="ipv6-log-head">
            <span>⚅ 运行日志 <span id="ipv6_log_time" style="opacity:.5">--</span></span>
            <div class="ipv6-log-btns">
              <button id="ipv6_toggle_auto">⏸</button>
              <button id="ipv6_refresh_log_btn">刷新</button>
              <button id="ipv6_clear_log_btn">清空</button>
            </div>
          </div>
          <div class="ipv6-log-area">
            <pre id="ipv6_log_text">（暂无日志）</pre>
          </div>
        </div>
      </div>
    </div>
  `;

  const injectPanel = () => {
    const old = document.querySelector(`#${PANEL_ID}`);
    if (old) old.remove();
    const container = document.querySelector(CONTAINER_SELECTOR);
    if (!container) { setTimeout(injectPanel, 500); return; }
    container.insertAdjacentHTML('afterend', render());
    bindEvents();
    const content = document.querySelector('#ipv6_collapse_content');
    if (content) {
      content.style.height = '0px';
      content.style.overflow = 'hidden';
    }
    refreshAll(true);
    startAutoRefresh();
  };

  const bindEvents = () => {
    const root = document.querySelector(`#${PANEL_ID}`);
    if (!root) return;
    root.querySelector('#ipv6_collapse_btn').onclick = (e) => { e.stopPropagation(); toggleCollapse(); };
    root.querySelector('#ipv6_title_click').onclick = (e) => {
      if (!e.target.closest('button')) toggleCollapse();
    };
    root.querySelector('#ipv6_repair_btn').onclick = installService;
    root.querySelector('#ipv6_check_btn').onclick = checkIpv6Now;
    root.querySelector('#ipv6_start_btn').onclick = startService;
    root.querySelector('#ipv6_stop_btn').onclick = stopService;
    root.querySelector('#ipv6_restart_btn').onclick = restartService;
    root.querySelector('#ipv6_manual_btn').onclick = manualRestartBaseband;
    root.querySelector('#ipv6_boot_btn').onclick = toggleBoot;
    root.querySelector('#ipv6_uninstall_btn').onclick = uninstallService;
    root.querySelector('#ipv6_refresh_btn').onclick = () => refreshAll(true);
    root.querySelector('#ipv6_help_btn').onclick = showHelp;
    root.querySelector('#ipv6_refresh_log_btn').onclick = loadLog;
    root.querySelector('#ipv6_clear_log_btn').onclick = clearLog;
    root.querySelector('#ipv6_toggle_auto').onclick = () => {
      state.autoRefresh ? stopAutoRefresh() : startAutoRefresh();
    };
  };

  const init = () => {
    if (document.querySelector(CONTAINER_SELECTOR)) {
      injectPanel();
      return;
    }
    const observer = new MutationObserver(() => {
      if (document.querySelector(CONTAINER_SELECTOR)) {
        observer.disconnect();
        injectPanel();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      if (!document.querySelector(`#${PANEL_ID}`)) injectPanel();
    }, 5000);
  };

  init();
})();
// </script>
