package com.hongguo.api;

import com.hongguo.api.util.Log;

/**
 * 入口。
 *
 * 用法：
 *   java -jar hongguo-api.jar                启动服务（含签名服务，默认 127.0.0.1:8000）
 *   java -jar hongguo-api.jar --no-sign      仅 API（免签列表页）
 *   java -jar hongguo-api.jar --sign-only    仅签名服务
 *   java -jar hongguo-api.jar --selftest     跑自检（算法回归 + 环境探测）
 *   java -jar hongguo-api.jar --version      显示版本
 *
 * 编排逻辑见 Launcher；这里只保留版本号与自检两项轻量入口。
 */
public final class Main {

    public static void main(String[] args) throws Exception {
        // 先锁定 UTF-8 输出：所有入口（自检/签名/完整）都经由此处，
        // 否则中文 Windows 控制台会出现「红红果果」式的双重编码乱码。
        Log.initEncoding();

        for (String a : args) {
            if (a.equals("--version") || a.equals("-v")) {
                System.out.println("hongguo-api 1.0.0");
                return;
            }
        }

        for (String a : args) {
            if (a.equals("--selftest")) {
                System.exit(SelfTest.run());
                return;
            }
        }

        Launcher.main(args);
    }
}
