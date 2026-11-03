package org.vslabs.wam_miner; // Change to your package name

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class SplashActivity extends AppCompatActivity {

    private TextView tvStatus;
    // Executor to run networking code on a separate background thread
    private final ExecutorService executorService = Executors.newSingleThreadExecutor();
    // Handler bound to the main thread loop to safely change UI text
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_splash);

        tvStatus = findViewById(R.id.tvStatus);

        // Start the background process
        initializeApp();
    }

    private void initializeApp() {

        // Offload network/parsing work to the background executor
        executorService.execute(() -> {

            // Detect specifications
            String hardwareSpecs = DeviceHardwareUtil.getDeviceHardwareSpecs(SplashActivity.this);

            mainHandler.post(() -> {
                // Small delay so the user can read the success message
                mainHandler.postDelayed(() -> {
                    Intent intent = new Intent(SplashActivity.this, MainActivity.class);
                    intent.putExtra("HWINFO", hardwareSpecs);
                    startActivity(intent);
                    finish(); // Destroys SplashActivity so the user cannot back into it
                }, 1000);
            });
        });
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        // Clean up the executor to avoid memory leaks if the activity is destroyed early
        if (!executorService.isShutdown()) {
            executorService.shutdown();
        }
    }
}
