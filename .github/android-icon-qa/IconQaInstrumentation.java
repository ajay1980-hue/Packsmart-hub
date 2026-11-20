package com.packsmartsolutions.iconqa;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.Resources;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Region;
import android.graphics.drawable.AdaptiveIconDrawable;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.os.Bundle;
import java.io.File;
import java.io.FileOutputStream;
import java.util.Arrays;
import java.util.HashSet;

/** Runs only in a separate QA APK; adds no code or permissions to the app. */
public final class IconQaInstrumentation extends Instrumentation {
    private int checks;
    private void require(boolean ok, String message) {
        if (!ok) throw new AssertionError(message);
        checks++;
    }
    @Override public void onCreate(Bundle args) { super.onCreate(args); start(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            Context target = getTargetContext();
            String pkg = target.getPackageName();
            PackageManager pm = target.getPackageManager();
            PackageInfo info = pm.getPackageInfo(pkg, PackageManager.GET_PERMISSIONS);
            require(pkg.equals("com.packsmartsolutions.app.multiphoto"), "QA package changed");
            require(info.versionCode == 104, "Expected versionCode 104");
            require(info.versionName.equals("2.1.4-multiphoto"), "Version name changed");
            require(info.applicationInfo.minSdkVersion == 26, "Minimum SDK changed");
            require(info.applicationInfo.targetSdkVersion == 36, "Target SDK changed");
            require(new HashSet<>(Arrays.asList(info.requestedPermissions)).equals(
                new HashSet<>(Arrays.asList("android.permission.INTERNET",
                    "android.permission.ACCESS_NETWORK_STATE"))), "App permissions changed");
            require(pm.getLaunchIntentForPackage(pkg) != null, "Launcher activity missing");
            Resources res = pm.getResourcesForApplication(pkg);
            String resolvedIcon = res.getResourceName(info.applicationInfo.icon);
            // PackageManager selects roundIcon as the app icon on round-icon devices.
            require(resolvedIcon.endsWith(":mipmap/ic_launcher")
                || resolvedIcon.endsWith(":mipmap/ic_launcher_round"),
                "Unexpected resolved app icon: " + resolvedIcon);
            for (String name : new String[]{"ic_launcher", "ic_launcher_round"}) {
                int id = res.getIdentifier(name, "mipmap", pkg);
                require(id != 0, "Missing " + name);
                for (int density : new int[]{120, 160, 240, 320, 480, 640}) {
                    Drawable icon = res.getDrawableForDensity(id, density, null);
                    require(icon instanceof AdaptiveIconDrawable, "Not an adaptive icon: " + name);
                    AdaptiveIconDrawable adaptive = (AdaptiveIconDrawable) icon;
                    Bitmap rendered = Bitmap.createBitmap(216, 216, Bitmap.Config.ARGB_8888);
                    adaptive.setBounds(0, 0, 216, 216);
                    adaptive.draw(new Canvas(rendered));
                    Bitmap foreground = Bitmap.createBitmap(216, 216, Bitmap.Config.ARGB_8888);
                    adaptive.getForeground().draw(new Canvas(foreground));
                    Region mask = new Region();
                    mask.setPath(adaptive.getIconMask(), new Region(0, 0, 216, 216));
                    int gold = 0, silver = 0, outside = 0;
                    for (int y = 0; y < 216; y++) for (int x = 0; x < 216; x++) {
                        int color = foreground.getPixel(x, y);
                        int a = color >>> 24, r = (color >> 16) & 255;
                        int g = (color >> 8) & 255, b = color & 255;
                        if (a < 128) continue;
                        boolean goldPixel = r > 70 && g > 35 && r > b * 1.25 && g > b * 1.1;
                        boolean silverPixel = r > 100 && g > 100 && b > 100
                            && Math.max(r, Math.max(g, b)) - Math.min(r, Math.min(g, b)) < 30;
                        if (goldPixel) gold++;
                        if (silverPixel) silver++;
                        if ((goldPixel || silverPixel) && !mask.contains(x, y)) outside++;
                    }
                    require(gold > 100 && silver > 100, "PS artwork missing at density " + density);
                    require(outside == 0, "PS artwork clipped by the device mask at density " + density);
                    if (density == 320) {
                        File image = new File(target.getCacheDir(), name + ".png");
                        try (FileOutputStream out = new FileOutputStream(image)) {
                            require(rendered.compress(Bitmap.CompressFormat.PNG, 100, out),
                                "Could not save framework-rendered icon");
                        }
                    }
                }
            }
            result.putString("stream", "ICON_QA_PASS: " + checks + " checks; API "
                + Build.VERSION.SDK_INT + "; " + Build.SUPPORTED_ABIS[0]
                + "; resolved icon: " + resolvedIcon + "\n");
            result.putInt("checks", checks);
            finish(Activity.RESULT_OK, result);
        } catch (Throwable error) {
            result.putString("stream", "ICON_QA_FAIL: " + error + "\n");
            finish(Activity.RESULT_CANCELED, result);
        }
    }
}
