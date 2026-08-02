import time
import requests
import concurrent.futures

BASE_URL = "http://localhost:8001"
NUM_REQUESTS = 100
CONCURRENCY = 10

def make_request(i):
    start = time.time()
    try:
        # Fast O(1) endpoint for rate limit testing
        response = requests.get(f"{BASE_URL}/cold-start?count=5", timeout=5)
        status = response.status_code
    except Exception as e:
        status = str(e)
    end = time.time()
    return status, end - start

def run_stress_test():
    print(f"Starting stress test: {NUM_REQUESTS} requests with concurrency {CONCURRENCY}")
    start_total = time.time()
    
    status_counts = {}
    latencies = []
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=CONCURRENCY) as executor:
        futures = [executor.submit(make_request, i) for i in range(NUM_REQUESTS)]
        for future in concurrent.futures.as_completed(futures):
            status, latency = future.result()
            status_counts[status] = status_counts.get(status, 0) + 1
            latencies.append(latency)
            
    end_total = time.time()
    
    print("\n--- Stress Test Results ---")
    print(f"Total Time: {end_total - start_total:.2f} seconds")
    print(f"Requests/sec: {NUM_REQUESTS / (end_total - start_total):.2f}")
    
    if latencies:
        print(f"Avg Latency: {sum(latencies)/len(latencies):.4f} seconds")
        print(f"Max Latency: {max(latencies):.4f} seconds")
        print(f"Min Latency: {min(latencies):.4f} seconds")
        
    print("Status Codes:")
    for status, count in status_counts.items():
        print(f"  {status}: {count}")
        
    # Test rate limiter
    if 429 in status_counts:
        print("\n[SUCCESS] Rate limiter 429 Too Many Requests triggered!")
    else:
        print("\n[FAILED] Rate limiter did not trigger.")

if __name__ == "__main__":
    run_stress_test()
