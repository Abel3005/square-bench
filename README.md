# Square-bench

Square-bench is the benchmark for testing AI agents in real terminal environments.

Harness Engineering has been primary in AI.

So We should test and verify it.

## Platform
- Next.js


# References

**Access SWE-bench via Hugging Face**:

- swe-bench is standard dataset
- example code with python

```python
from datasets import load_dataset
swebench = load_dataset('princeton-nlp/SWE-bench', split='test')
```

**Access Squarecode**:

squarecode is cli agent program.

- **run squarecode**: squarecode run [prompt]
- **run squarecode**: squarecode run --agent=deepwork-headless [prompt]